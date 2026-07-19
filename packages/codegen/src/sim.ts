import * as T from '@compy/cc';
import { Memory, Console, Syscalls, Vfs, CFault } from '@compy/runtime';
import { NativeFn, NativeHost, Val, VarView, intVal, floatVal, ptrVal, ProgramExit, CRuntimeError } from '@compy/vm';
import { Module, Sig, IrType, isFloatType } from '@compy/ir';
import { MModule, MInstr, MFunc, INT_REGS, FLOAT_REGS, fmtMInstr } from './mir';
import { assignArgs } from './isel';

/**
 * A RISC-V RV32IMFD simulator that runs the generated code over the same
 * segmented Memory and libc as the other engines. Library functions are
 * "linked" as trampolines at real text addresses, so function pointers and
 * indirect calls behave exactly like calls to compiled code: when the pc
 * lands on a trampoline the simulator decodes the arguments per the calling
 * convention, runs the host implementation, and places the result in a0/fa0.
 */

export interface SimStepEvent {
  pc: number;
  index: number;
  instr: MInstr;
  text: string;
  fn: string;
  line?: number;
  depth: number;
}

export interface SimOptions {
  memory?: Memory;
  console?: Console;
  syscalls?: Syscalls;
  vfs?: Vfs;
  natives?: Record<string, NativeFn>;
  argv?: string[];
  maxSteps?: number;
  onStep?: (ev: SimStepEvent, sim: Simulator) => void;
  onLine?: (line: number, sim: Simulator) => void;
  onFinish?: (sim: Simulator) => void;
}

export interface SimResult {
  exitCode: number;
  faults: CFault[];
  leaks: { addr: number; size: number }[];
  fatal?: CFault;
  steps: number;
}

interface CodeEntry {
  instr: MInstr;
  fn: string;
}

const EXIT_SENTINEL = 0xfffffff0;
const NESTED_SENTINEL = 0xffffffe0;

export class Simulator implements NativeHost {
  readonly mem: Memory;
  readonly con: Console;
  readonly sys: Syscalls;
  readonly vfs: Vfs;
  /** Integer registers (x0–x31) as signed 32-bit numbers. */
  readonly x = new Int32Array(32);
  /** Floating registers (f0–f31). Single-precision values are stored rounded. */
  readonly f = new Float64Array(32);
  pc = 0;
  steps = 0;
  private readonly natives: Record<string, NativeFn>;
  private readonly argv: string[];
  private readonly maxSteps: number;
  readonly code: CodeEntry[] = [];
  readonly textBase: number;
  readonly labelAddr = new Map<string, number>();
  private readonly nativeByAddr = new Map<number, string>();
  private readonly nativeAddr = new Map<string, number>();
  private readonly stringAddr: number[] = [];
  private readonly stringPool = new Map<string, number>();
  private readonly atexitList: number[] = [];
  private readonly onStep?: SimOptions['onStep'];
  private readonly onLine?: SimOptions['onLine'];
  private readonly onFinish?: SimOptions['onFinish'];
  private depth = 0;
  private lastLine = -1;
  /** Call stack reconstructed from calls/returns, for the UI. */
  readonly frames: { name: string; line: number; fp: number }[] = [];

  constructor(
    readonly mmod: MModule,
    readonly ir: Module,
    opts: SimOptions = {},
  ) {
    this.vfs = opts.vfs ?? new Vfs();
    this.con = opts.console ?? new Console();
    this.mem = opts.memory ?? new Memory();
    this.sys = opts.syscalls ?? new Syscalls(this.vfs, this.con);
    this.natives = { ...builtinHelpers(), ...(opts.natives ?? {}) };
    this.argv = opts.argv ?? ['program'];
    this.maxSteps = opts.maxSteps ?? 50_000_000;
    this.onStep = opts.onStep;
    this.onLine = opts.onLine;
    this.onFinish = opts.onFinish;
    this.textBase = this.mem.segments.text.start + 16;
    this.layout();
  }

  // -- image -----------------------------------------------------------------

  private layout(): void {
    // Code: every instruction occupies 4 bytes.
    for (const fn of this.mmod.functions) {
      for (const b of fn.blocks) {
        this.labelAddr.set(b.name, this.textBase + 4 * this.code.length);
        for (const i of b.instrs) this.code.push({ instr: i, fn: fn.name });
      }
    }
    // Trampolines for host functions, after the code.
    let next = this.textBase + 4 * this.code.length + 16;
    const needed = new Set<string>(this.ir.externs);
    for (const n of Object.keys(this.natives)) needed.add(n);
    for (const n of needed) {
      if (this.labelAddr.has(n)) continue;
      if (!this.natives[n]) continue;
      this.nativeByAddr.set(next, n);
      this.nativeAddr.set(n, next);
      this.labelAddr.set(n, next);
      next += 16;
    }
    // Rodata: strings and float constants.
    this.ir.strings.forEach((s) => this.stringAddr.push(this.internBytes(s)));
    this.ir.strings.forEach((_, k) => this.labelAddr.set(`.str${k}`, this.stringAddr[k]!));
    for (const fc of this.mmod.floatConsts) {
      const bytes = new Uint8Array(8);
      const dv = new DataView(bytes.buffer);
      if (fc.bits === 32) dv.setFloat32(0, fc.value, true);
      else dv.setFloat64(0, fc.value, true);
      this.labelAddr.set(fc.label, this.mem.allocRodata(bytes.slice(0, fc.bits / 8)));
    }
    // Globals.
    for (const g of this.ir.globals) {
      const addr = g.init ? (g.readonly ? this.mem.allocRodata(g.init) : this.mem.allocData(g.init)) : this.mem.allocBss(g.size);
      this.labelAddr.set(g.name, addr);
    }
    for (const g of this.ir.globals) {
      const base = this.labelAddr.get(g.name)!;
      for (const r of g.relocs) {
        const target = (r.kind === 'str' ? this.stringAddr[r.ref as number] ?? 0 : this.labelAddr.get(r.ref as string) ?? 0) + r.addend;
        for (let k = 0; k < 4; k++) this.mem.poke(base + r.offset + k, (target >>> (8 * k)) & 0xff);
      }
    }
  }

  addressOf(symbol: string): number {
    const a = this.labelAddr.get(symbol);
    if (a === undefined) throw new CRuntimeError(`undefined symbol '${symbol}'`);
    return a;
  }

  // -- run -----------------------------------------------------------------------

  run(): SimResult {
    let exitCode = 0;
    let fatal: CFault | undefined;
    try {
      const main = this.labelAddr.get('main');
      if (main === undefined) throw new CRuntimeError('no main() function');
      this.setSp(this.mem.segments.stack.end);
      const mainFn = this.ir.functions.find((f) => f.name === 'main');
      if (mainFn && mainFn.params.length > 0) {
        const argc = this.argv.length;
        const ptrs = this.argv.map((s) => this.internCString(s));
        const arr = this.mem.malloc(4 * (argc + 1));
        ptrs.forEach((p, i) => this.mem.writeU32(arr + i * 4, p));
        this.mem.writeU32(arr + argc * 4, 0);
        this.x[10] = argc;
        this.x[11] = arr | 0;
      }
      this.x[1] = EXIT_SENTINEL | 0;
      this.pc = this.idx(main);
      this.frames.push({ name: 'main', line: 0, fp: this.x[2]! });
      this.depth = 1;
      this.loop(EXIT_SENTINEL);
      exitCode = this.x[10]! & 0xff;
      this.runAtexit();
    } catch (e) {
      if (e instanceof ProgramExit) {
        exitCode = e.code;
        this.runAtexit();
      } else if (e instanceof CFault) {
        fatal = e;
        this.con.write('err', `\nRuntime fault: ${e.kind} at 0x${e.addr.toString(16)} — ${e.message}\n`);
        exitCode = 139;
      } else if (e instanceof CRuntimeError) {
        this.con.write('err', `\nRuntime error: ${e.message}\n`);
        exitCode = 1;
      } else throw e;
    }
    try {
      this.onFinish?.(this);
    } catch {
      /* ignore */
    }
    const leaks = this.mem.leaks().map((b) => ({ addr: b.addr, size: b.size }));
    return { exitCode, faults: this.mem.warnings.slice(), leaks, fatal, steps: this.steps };
  }

  private idx(addr: number): number {
    return (addr - this.textBase) / 4;
  }

  /** Execute until a `ret` lands on `sentinel`. */
  private loop(sentinel: number): void {
    for (;;) {
      const entry = this.code[this.pc];
      if (!entry) throw new CFault('segfault', this.textBase + 4 * this.pc, 4, 'jumped outside the code segment');
      if (++this.steps > this.maxSteps) throw new CRuntimeError('execution step limit exceeded (infinite loop?)');
      const i = entry.instr;
      if (i.line !== undefined && i.line !== this.lastLine) {
        this.lastLine = i.line;
        const top = this.frames[this.frames.length - 1];
        if (top) top.line = i.line;
        this.onLine?.(i.line, this);
      }
      if (this.onStep) this.onStep({ pc: this.textBase + 4 * this.pc, index: this.pc, instr: i, text: fmtMInstr(i), fn: entry.fn, line: i.line, depth: this.depth }, this);
      const done = this.exec(i, sentinel);
      if (done) return;
    }
  }

  private r(name: string | undefined): number {
    const k = INT_REGS.indexOf(name!);
    if (k < 0) throw new CRuntimeError(`bad register ${name}`);
    return k;
  }
  private fr(name: string | undefined): number {
    const k = FLOAT_REGS.indexOf(name!);
    if (k < 0) throw new CRuntimeError(`bad float register ${name}`);
    return k;
  }
  private setX(k: number, v: number): void {
    if (k === 0) return;
    this.x[k] = v | 0;
    if (k === 2) this.setSp(this.x[2]! >>> 0);
  }
  private setSp(v: number): void {
    const s = this.mem.segments.stack;
    if (v < s.start) throw new CFault('stack-overflow', v, 0, 'the stack pointer went below the stack segment');
    this.x[2] = v | 0;
    s.top = v;
    this.mem.popStackTo(v); // marks freed stack bytes as uninitialized
  }
  private sp(): number {
    return this.x[2]! >>> 0;
  }

  /** Returns true when the sentinel return was reached. */
  private exec(i: MInstr, sentinel: number): boolean {
    const X = this.x;
    const F = this.f;
    const u = (k: number) => X[k]! >>> 0;
    let next = this.pc + 1;
    switch (i.op) {
      // -- integer arithmetic ------------------------------------------------
      case 'add': this.setX(this.r(i.rd), X[this.r(i.rs1)]! + X[this.r(i.rs2)]!); break;
      case 'addi': this.setX(this.r(i.rd), X[this.r(i.rs1)]! + i.imm!); break;
      case 'sub': this.setX(this.r(i.rd), X[this.r(i.rs1)]! - X[this.r(i.rs2)]!); break;
      case 'mul': this.setX(this.r(i.rd), Math.imul(X[this.r(i.rs1)]!, X[this.r(i.rs2)]!)); break;
      case 'div': {
        const b = X[this.r(i.rs2)]!;
        if (b === 0) throw new CRuntimeError('division by zero');
        this.setX(this.r(i.rd), Math.trunc(X[this.r(i.rs1)]! / b));
        break;
      }
      case 'divu': {
        const b = u(this.r(i.rs2));
        if (b === 0) throw new CRuntimeError('division by zero');
        this.setX(this.r(i.rd), Math.floor(u(this.r(i.rs1)) / b));
        break;
      }
      case 'rem': {
        const b = X[this.r(i.rs2)]!;
        if (b === 0) throw new CRuntimeError('division by zero');
        this.setX(this.r(i.rd), X[this.r(i.rs1)]! % b);
        break;
      }
      case 'remu': {
        const b = u(this.r(i.rs2));
        if (b === 0) throw new CRuntimeError('division by zero');
        this.setX(this.r(i.rd), u(this.r(i.rs1)) % b);
        break;
      }
      case 'and': this.setX(this.r(i.rd), X[this.r(i.rs1)]! & X[this.r(i.rs2)]!); break;
      case 'andi': this.setX(this.r(i.rd), X[this.r(i.rs1)]! & i.imm!); break;
      case 'or': this.setX(this.r(i.rd), X[this.r(i.rs1)]! | X[this.r(i.rs2)]!); break;
      case 'ori': this.setX(this.r(i.rd), X[this.r(i.rs1)]! | i.imm!); break;
      case 'xor': this.setX(this.r(i.rd), X[this.r(i.rs1)]! ^ X[this.r(i.rs2)]!); break;
      case 'xori': this.setX(this.r(i.rd), X[this.r(i.rs1)]! ^ i.imm!); break;
      case 'sll': this.setX(this.r(i.rd), X[this.r(i.rs1)]! << (X[this.r(i.rs2)]! & 31)); break;
      case 'slli': this.setX(this.r(i.rd), X[this.r(i.rs1)]! << (i.imm! & 31)); break;
      case 'srl': this.setX(this.r(i.rd), u(this.r(i.rs1)) >>> (X[this.r(i.rs2)]! & 31)); break;
      case 'srli': this.setX(this.r(i.rd), u(this.r(i.rs1)) >>> (i.imm! & 31)); break;
      case 'sra': this.setX(this.r(i.rd), X[this.r(i.rs1)]! >> (X[this.r(i.rs2)]! & 31)); break;
      case 'srai': this.setX(this.r(i.rd), X[this.r(i.rs1)]! >> (i.imm! & 31)); break;
      case 'slt': this.setX(this.r(i.rd), X[this.r(i.rs1)]! < X[this.r(i.rs2)]! ? 1 : 0); break;
      case 'slti': this.setX(this.r(i.rd), X[this.r(i.rs1)]! < i.imm! ? 1 : 0); break;
      case 'sltu': this.setX(this.r(i.rd), u(this.r(i.rs1)) < u(this.r(i.rs2)) ? 1 : 0); break;
      case 'sltiu': this.setX(this.r(i.rd), u(this.r(i.rs1)) < (i.imm! >>> 0) ? 1 : 0); break;
      case 'seqz': this.setX(this.r(i.rd), X[this.r(i.rs1)] === 0 ? 1 : 0); break;
      case 'snez': this.setX(this.r(i.rd), X[this.r(i.rs1)] !== 0 ? 1 : 0); break;
      case 'neg': this.setX(this.r(i.rd), -X[this.r(i.rs1)]!); break;
      case 'not': this.setX(this.r(i.rd), ~X[this.r(i.rs1)]!); break;
      case 'li': this.setX(this.r(i.rd), i.imm!); break;
      case 'lui': this.setX(this.r(i.rd), i.imm! << 12); break;
      case 'mv': this.setX(this.r(i.rd), X[this.r(i.rs1)]!); break;
      case 'la': this.setX(this.r(i.rd), this.addressOf(i.target!)); break;
      case 'nop': break;
      // -- memory ------------------------------------------------------------
      case 'lw': this.setX(this.r(i.rd), this.mem.readI32(this.ea(i))); break;
      case 'lh': this.setX(this.r(i.rd), this.mem.readI16(this.ea(i))); break;
      case 'lhu': this.setX(this.r(i.rd), this.mem.readU16(this.ea(i))); break;
      case 'lb': this.setX(this.r(i.rd), this.mem.readI8(this.ea(i))); break;
      case 'lbu': this.setX(this.r(i.rd), this.mem.readU8(this.ea(i))); break;
      case 'sw': this.mem.writeI32(this.ea(i), X[this.r(i.rs2)]!); break;
      case 'sh': this.mem.writeI16(this.ea(i), X[this.r(i.rs2)]! & 0xffff); break;
      case 'sb': this.mem.writeU8(this.ea(i), X[this.r(i.rs2)]! & 0xff); break;
      case 'flw': F[this.fr(i.rd)] = this.mem.readF32(this.ea(i)); break;
      case 'fld': F[this.fr(i.rd)] = this.mem.readF64(this.ea(i)); break;
      case 'fsw': this.mem.writeF32(this.ea(i), F[this.fr(i.rs2)]!); break;
      case 'fsd': this.mem.writeF64(this.ea(i), F[this.fr(i.rs2)]!); break;
      // -- floating point ------------------------------------------------------
      case 'fadd.s': F[this.fr(i.rd)] = Math.fround(F[this.fr(i.rs1)]! + F[this.fr(i.rs2)]!); break;
      case 'fsub.s': F[this.fr(i.rd)] = Math.fround(F[this.fr(i.rs1)]! - F[this.fr(i.rs2)]!); break;
      case 'fmul.s': F[this.fr(i.rd)] = Math.fround(F[this.fr(i.rs1)]! * F[this.fr(i.rs2)]!); break;
      case 'fdiv.s': F[this.fr(i.rd)] = Math.fround(F[this.fr(i.rs1)]! / F[this.fr(i.rs2)]!); break;
      case 'fadd.d': F[this.fr(i.rd)] = F[this.fr(i.rs1)]! + F[this.fr(i.rs2)]!; break;
      case 'fsub.d': F[this.fr(i.rd)] = F[this.fr(i.rs1)]! - F[this.fr(i.rs2)]!; break;
      case 'fmul.d': F[this.fr(i.rd)] = F[this.fr(i.rs1)]! * F[this.fr(i.rs2)]!; break;
      case 'fdiv.d': F[this.fr(i.rd)] = F[this.fr(i.rs1)]! / F[this.fr(i.rs2)]!; break;
      case 'fmv.s': case 'fmv.d': F[this.fr(i.rd)] = F[this.fr(i.rs1)]!; break;
      case 'fneg.s': case 'fneg.d': F[this.fr(i.rd)] = -F[this.fr(i.rs1)]!; break;
      case 'feq.s': case 'feq.d': this.setX(this.r(i.rd), F[this.fr(i.rs1)] === F[this.fr(i.rs2)] ? 1 : 0); break;
      case 'flt.s': case 'flt.d': this.setX(this.r(i.rd), F[this.fr(i.rs1)]! < F[this.fr(i.rs2)]! ? 1 : 0); break;
      case 'fle.s': case 'fle.d': this.setX(this.r(i.rd), F[this.fr(i.rs1)]! <= F[this.fr(i.rs2)]! ? 1 : 0); break;
      case 'fcvt.s.w': F[this.fr(i.rd)] = Math.fround(X[this.r(i.rs1)]!); break;
      case 'fcvt.s.wu': F[this.fr(i.rd)] = Math.fround(u(this.r(i.rs1))); break;
      case 'fcvt.d.w': F[this.fr(i.rd)] = X[this.r(i.rs1)]!; break;
      case 'fcvt.d.wu': F[this.fr(i.rd)] = u(this.r(i.rs1)); break;
      case 'fcvt.w.s': case 'fcvt.w.d': this.setX(this.r(i.rd), toInt32(F[this.fr(i.rs1)]!)); break;
      case 'fcvt.wu.s': case 'fcvt.wu.d': this.setX(this.r(i.rd), toUint32(F[this.fr(i.rs1)]!)); break;
      case 'fcvt.d.s': F[this.fr(i.rd)] = F[this.fr(i.rs1)]!; break;
      case 'fcvt.s.d': F[this.fr(i.rd)] = Math.fround(F[this.fr(i.rs1)]!); break;
      // -- control flow ----------------------------------------------------------
      case 'j': next = this.idx(this.addressOf(i.target!)); break;
      case 'beq': if (X[this.r(i.rs1)] === X[this.r(i.rs2)]) next = this.idx(this.addressOf(i.target!)); break;
      case 'bne': if (X[this.r(i.rs1)] !== X[this.r(i.rs2)]) next = this.idx(this.addressOf(i.target!)); break;
      case 'blt': if (X[this.r(i.rs1)]! < X[this.r(i.rs2)]!) next = this.idx(this.addressOf(i.target!)); break;
      case 'bge': if (X[this.r(i.rs1)]! >= X[this.r(i.rs2)]!) next = this.idx(this.addressOf(i.target!)); break;
      case 'bltu': if (u(this.r(i.rs1)) < u(this.r(i.rs2))) next = this.idx(this.addressOf(i.target!)); break;
      case 'bgeu': if (u(this.r(i.rs1)) >= u(this.r(i.rs2))) next = this.idx(this.addressOf(i.target!)); break;
      case 'beqz': if (X[this.r(i.rs1)] === 0) next = this.idx(this.addressOf(i.target!)); break;
      case 'bnez': if (X[this.r(i.rs1)] !== 0) next = this.idx(this.addressOf(i.target!)); break;
      case 'call': {
        const target = this.addressOf(i.target!);
        X[1] = (this.textBase + 4 * (this.pc + 1)) | 0;
        next = this.enter(target, i, next);
        break;
      }
      case 'jalr': {
        const target = u(this.r(i.rs1));
        X[1] = (this.textBase + 4 * (this.pc + 1)) | 0;
        next = this.enter(target, i, next);
        break;
      }
      case 'ret': {
        const ra = u(1);
        this.frames.pop();
        this.depth--;
        if (ra === sentinel) return true;
        if (ra === EXIT_SENTINEL || ra === NESTED_SENTINEL) throw new CRuntimeError('return address stack is corrupted');
        next = this.idx(ra);
        if (!Number.isInteger(next)) throw new CFault('segfault', ra, 4, 'returned to a bad address');
        break;
      }
      case 'ebreak': throw new CRuntimeError('reached unreachable code (missing return?)');
      default:
        throw new CRuntimeError(`simulator: unknown instruction '${i.op}'`);
    }
    this.pc = next;
    return false;
  }

  private ea(i: MInstr): number {
    return (this.x[this.r(i.rs1)]! + (i.imm ?? 0)) >>> 0;
  }

  /** Transfer control to `target`: compiled code, or a host trampoline. */
  private enter(target: number, call: MInstr, next: number): number {
    const native = this.nativeByAddr.get(target);
    if (native) {
      this.bridge(native, call.sig);
      return next; // the trampoline "returned" immediately
    }
    const idx = this.idx(target);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.code.length) throw new CFault('segfault', target, 4, 'call through an invalid function pointer');
    if (this.depth > 6000) throw new CFault('stack-overflow', this.sp(), 0, 'call depth exceeded');
    this.depth++;
    this.frames.push({ name: this.code[idx]!.fn, line: this.code[idx]!.instr.line ?? 0, fp: this.sp() });
    return idx;
  }

  // -- host bridge ---------------------------------------------------------------------

  private bridge(name: string, sig: Sig | undefined): void {
    const fn = this.natives[name]!;
    const s: Sig = sig ?? { ret: 'i32', params: [], variadic: true, fixed: 0 };
    const { locs } = assignArgs(s.params, s.fixed ?? s.params.length);
    const args: Val[] = locs.map((loc) => {
      switch (loc.kind) {
        case 'ireg': return toVal(loc.type, BigInt(this.x[INT_REGS.indexOf(loc.reg!)]!));
        case 'freg': return floatVal(loc.type === 'f32' ? T.FLOAT : T.DOUBLE, this.f[FLOAT_REGS.indexOf(loc.reg!)]!);
        case 'ipair': {
          const lo = BigInt(this.x[INT_REGS.indexOf(loc.reg!)]! >>> 0);
          const hi = BigInt(this.x[INT_REGS.indexOf(loc.hi!)]! >>> 0);
          const bits = (hi << 32n) | lo;
          if (isFloatType(loc.type)) return floatVal(T.DOUBLE, bitsToDouble(bits));
          return intVal(T.LLONG, BigInt.asIntN(64, bits));
        }
        case 'stack': {
          const addr = this.sp() + loc.offset!;
          if (loc.type === 'i64') return intVal(T.LLONG, this.mem.readI64(addr));
          if (loc.type === 'f64') return floatVal(T.DOUBLE, this.mem.readF64(addr));
          if (loc.type === 'f32') return floatVal(T.FLOAT, this.mem.readF32(addr));
          return toVal(loc.type, BigInt(this.mem.readI32(addr)));
        }
      }
    });
    const r = fn(this, args);
    if (!r) return;
    if (s.ret === 'i64') {
      const v = BigInt.asUintN(64, r.type.kind === 'float' ? BigInt(Math.trunc(r.f)) : r.i);
      this.x[10] = Number(v & 0xffffffffn) | 0;
      this.x[11] = Number(v >> 32n) | 0;
    } else if (isFloatType(s.ret)) {
      this.f[10] = r.type.kind === 'float' ? (s.ret === 'f32' ? Math.fround(r.f) : r.f) : Number(r.i);
    } else {
      this.x[10] = Number(BigInt.asIntN(32, r.type.kind === 'float' ? BigInt(Math.trunc(r.f)) : r.i)) | 0;
    }
  }

  // -- NativeHost ------------------------------------------------------------------------

  readCString(addr: number): string {
    if (addr === 0) return '';
    const out: number[] = [];
    for (let i = 0; ; i++) {
      const b = this.mem.readU8(addr + i);
      if (b === 0) break;
      out.push(b);
      if (i > 1 << 20) break;
    }
    return new TextDecoder().decode(new Uint8Array(out));
  }
  internCString(s: string): number {
    return this.internBytes(new Uint8Array([...new TextEncoder().encode(s), 0]));
  }
  private internBytes(bytes: Uint8Array): number {
    const key = bytes.join(',');
    const cached = this.stringPool.get(key);
    if (cached !== undefined) return cached;
    const addr = this.mem.allocRodata(bytes);
    this.stringPool.set(key, addr);
    return addr;
  }
  malloc(n: number): number {
    return this.mem.malloc(n);
  }
  exit(code: number): never {
    throw new ProgramExit(code);
  }
  registerAtexit(addr: number): void {
    this.atexitList.push(addr);
  }
  callDepth(): number {
    return this.depth;
  }

  /** Run a compiled function from inside a host function (qsort's comparator, atexit). */
  callFunctionPointer(addr: number, args: Val[]): Val | null {
    const native = this.nativeByAddr.get(addr);
    if (native) return this.natives[native]!(this, args);
    const idx = this.idx(addr);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.code.length) throw new CFault('segfault', addr, 4, 'call through an invalid function pointer');
    // Save the caller-visible machine state we must restore.
    const savedPc = this.pc;
    const savedX = Int32Array.from(this.x);
    const savedF = Float64Array.from(this.f);
    const savedLine = this.lastLine;
    // Arguments per the ABI, from the Val types.
    const types: IrType[] = args.map((a) => (a.type.kind === 'float' ? (a.type.bytes === 4 ? 'f32' : 'f64') : a.type.kind === 'int' && a.type.bytes === 8 ? 'i64' : 'i32'));
    const { locs, stackBytes } = assignArgs(types, types.length);
    if (stackBytes) this.setSp(this.sp() - stackBytes);
    locs.forEach((loc, k) => {
      const a = args[k]!;
      switch (loc.kind) {
        case 'ireg': this.x[INT_REGS.indexOf(loc.reg!)] = Number(BigInt.asIntN(32, a.i)) | 0; break;
        case 'freg': this.f[FLOAT_REGS.indexOf(loc.reg!)] = a.f; break;
        case 'ipair': {
          const v = BigInt.asUintN(64, a.i);
          this.x[INT_REGS.indexOf(loc.reg!)] = Number(v & 0xffffffffn) | 0;
          this.x[INT_REGS.indexOf(loc.hi!)] = Number(v >> 32n) | 0;
          break;
        }
        case 'stack': this.mem.writeI32(this.sp() + loc.offset!, Number(BigInt.asIntN(32, a.i))); break;
      }
    });
    this.x[1] = NESTED_SENTINEL | 0;
    this.pc = idx;
    this.depth++;
    this.frames.push({ name: this.code[idx]!.fn, line: 0, fp: this.sp() });
    this.loop(NESTED_SENTINEL);
    const fnIr = this.ir.functions.find((f) => this.labelAddr.get(f.name) === addr);
    let result: Val | null = null;
    if (fnIr && fnIr.ret !== 'void') {
      if (fnIr.ret === 'i64') result = intVal(T.LLONG, BigInt.asIntN(64, (BigInt(this.x[11]! >>> 0) << 32n) | BigInt(this.x[10]! >>> 0)));
      else if (isFloatType(fnIr.ret)) result = floatVal(fnIr.ret === 'f32' ? T.FLOAT : T.DOUBLE, this.f[10]!);
      else result = intVal(T.INT, BigInt(this.x[10]!));
    }
    if (stackBytes) this.setSp(this.sp() + stackBytes);
    this.pc = savedPc;
    this.x.set(savedX);
    this.f.set(savedF);
    this.lastLine = savedLine;
    return result;
  }

  private runAtexit(): void {
    for (let k = this.atexitList.length - 1; k >= 0; k--) {
      try {
        this.callFunctionPointer(this.atexitList[k]!, []);
      } catch {
        /* ignore */
      }
    }
  }

  // -- inspection ------------------------------------------------------------------------

  callStack(): { name: string; line: number }[] {
    return this.frames.map((f) => ({ name: f.name, line: f.line }));
  }

  /** Locals of the current frame, read from their stack slots. */
  frameVars(): VarView[] {
    const top = this.frames[this.frames.length - 1];
    if (!top) return [];
    const fn = this.mmod.functions.find((f) => f.name === top.name);
    const irFn = this.ir.functions.find((f) => f.name === top.name);
    if (!fn || !irFn) return [];
    const fp = this.x[8]! >>> 0;
    const out: VarView[] = [];
    for (const a of fn.allocas) {
      const off = this.allocaOffset(fn, a.name);
      if (off === undefined) continue;
      const addr = (fp + off) >>> 0;
      const id = Number(a.name.split('#')[1]);
      const alloca = irFn.blocks.flatMap((b) => b.instrs).find((i) => i.op === 'alloca' && i.dst.id === id);
      const ct = alloca && alloca.op === 'alloca' ? alloca.ct : undefined;
      out.push({ name: a.name.split('#')[0]!, type: a.ctype, addr, value: ct ? this.formatAt(addr, ct) : '?' });
    }
    return out;
  }
  private allocaOffset(fn: MFunc, name: string): number | undefined {
    // Recover the offset from the `addi rd, s0, off` that materializes the slot.
    for (const b of fn.blocks) for (const i of b.instrs) if (i.op === 'addi' && i.rs1 === 's0' && i.comment === `&${name.split('#')[0]}` && i.imm !== undefined) return i.imm;
    return undefined;
  }

  globalVars(): VarView[] {
    const out: VarView[] = [];
    for (const g of this.ir.globals) {
      const addr = this.labelAddr.get(g.name);
      if (addr === undefined) continue;
      out.push({ name: g.name, type: g.ctype, addr, value: g.ct ? this.formatAt(addr, g.ct) : '?' });
    }
    return out;
  }

  formatAt(addr: number, type: T.CType): string {
    try {
      if (type.kind === 'array') {
        if (type.of.kind === 'int' && type.of.bytes === 1) return JSON.stringify(this.readCString(addr));
        const n = Math.min(type.length ?? 0, 8);
        const parts: string[] = [];
        for (let k = 0; k < n; k++) parts.push(this.formatAt(addr + k * T.sizeof(type.of), type.of));
        return '{' + parts.join(', ') + (type.length && type.length > n ? ', …' : '') + '}';
      }
      if (type.kind === 'struct' || type.kind === 'union') return '{' + type.fields.map((f) => `${f.name}=${this.formatAt(addr + f.offset, f.type)}`).join(', ') + '}';
      if (type.kind === 'float') return String(type.bytes === 4 ? this.mem.readF32(addr) : this.mem.readF64(addr));
      if (type.kind === 'pointer' || type.kind === 'function') {
        const p = this.mem.readU32(addr);
        return p === 0 ? 'NULL' : '0x' + p.toString(16);
      }
      if (type.kind === 'int') {
        switch (type.bytes) {
          case 1: return String(type.signed ? this.mem.readI8(addr) : this.mem.readU8(addr));
          case 2: return String(type.signed ? this.mem.readI16(addr) : this.mem.readU16(addr));
          case 8: return String(type.signed ? this.mem.readI64(addr) : this.mem.readU64(addr));
          default: return String(type.signed ? this.mem.readI32(addr) : this.mem.readU32(addr));
        }
      }
      return String(this.mem.readI32(addr));
    } catch {
      return '<?>';
    }
  }

  /** Register file snapshot for the UI. */
  registers(): { name: string; value: number }[] {
    return INT_REGS.map((name, k) => ({ name, value: this.x[k]! }));
  }
  floatRegisters(): { name: string; value: number }[] {
    return FLOAT_REGS.map((name, k) => ({ name, value: this.f[k]! }));
  }
}

// -- helpers ---------------------------------------------------------------------------------

function toVal(t: IrType, v: bigint): Val {
  switch (t) {
    case 'i8': return intVal(T.CHAR, v);
    case 'i16': return intVal(T.SHORT, v);
    case 'ptr': return ptrVal(T.pointerTo(T.VOID), Number(BigInt.asUintN(32, v)));
    default: return intVal(T.INT, v);
  }
}

function toInt32(f: number): number {
  if (Number.isNaN(f)) return 0;
  if (f >= 2147483647) return 2147483647;
  if (f <= -2147483648) return -2147483648;
  return Math.trunc(f) | 0;
}
function toUint32(f: number): number {
  if (Number.isNaN(f) || f <= 0) return 0;
  if (f >= 4294967295) return -1;
  return Math.trunc(f) >>> 0;
}
function bitsToDouble(bits: bigint): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, bits, true);
  return dv.getFloat64(0, true);
}

/** The 64-bit integer and conversion helpers gcc would link from libgcc. */
export function builtinHelpers(): Record<string, NativeFn> {
  const i64 = (a: Val[], k: number): bigint => BigInt.asIntN(64, a[k]?.i ?? 0n);
  const u64 = (a: Val[], k: number): bigint => BigInt.asUintN(64, a[k]?.i ?? 0n);
  const ret = (v: bigint): Val => intVal(T.LLONG, BigInt.asIntN(64, v));
  const cmp = (x: bigint, y: bigint): Val => intVal(T.INT, x < y ? 0n : x === y ? 1n : 2n);
  return {
    __muldi3: (_c, a) => ret(i64(a, 0) * i64(a, 1)),
    __divdi3: (_c, a) => { if (i64(a, 1) === 0n) throw new CRuntimeError('division by zero'); return ret(i64(a, 0) / i64(a, 1)); },
    __udivdi3: (_c, a) => { if (u64(a, 1) === 0n) throw new CRuntimeError('division by zero'); return ret(u64(a, 0) / u64(a, 1)); },
    __moddi3: (_c, a) => { if (i64(a, 1) === 0n) throw new CRuntimeError('division by zero'); return ret(i64(a, 0) % i64(a, 1)); },
    __umoddi3: (_c, a) => { if (u64(a, 1) === 0n) throw new CRuntimeError('division by zero'); return ret(u64(a, 0) % u64(a, 1)); },
    __ashldi3: (_c, a) => ret(u64(a, 0) << (BigInt(Number(a[1]?.i ?? 0n)) & 63n)),
    __lshrdi3: (_c, a) => ret(u64(a, 0) >> (BigInt(Number(a[1]?.i ?? 0n)) & 63n)),
    __ashrdi3: (_c, a) => ret(i64(a, 0) >> (BigInt(Number(a[1]?.i ?? 0n)) & 63n)),
    __cmpdi2: (_c, a) => cmp(i64(a, 0), i64(a, 1)),
    __ucmpdi2: (_c, a) => cmp(u64(a, 0), u64(a, 1)),
    __floatdisf: (_c, a) => floatVal(T.FLOAT, Number(i64(a, 0))),
    __floatdidf: (_c, a) => floatVal(T.DOUBLE, Number(i64(a, 0))),
    __floatundisf: (_c, a) => floatVal(T.FLOAT, Number(u64(a, 0))),
    __floatundidf: (_c, a) => floatVal(T.DOUBLE, Number(u64(a, 0))),
    __fixsfdi: (_c, a) => ret(BigInt(Math.trunc(a[0]?.f ?? 0))),
    __fixdfdi: (_c, a) => ret(BigInt(Math.trunc(a[0]?.f ?? 0))),
    __fixunssfdi: (_c, a) => ret(BigInt(Math.max(0, Math.trunc(a[0]?.f ?? 0)))),
    __fixunsdfdi: (_c, a) => ret(BigInt(Math.max(0, Math.trunc(a[0]?.f ?? 0)))),
  };
}
