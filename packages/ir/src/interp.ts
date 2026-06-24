import * as T from '@compy/cc';
import { Memory, Console, Syscalls, Vfs, CFault } from '@compy/runtime';
import { NativeFn, NativeHost, Val, VarView, intVal, floatVal, ptrVal, ProgramExit, CRuntimeError } from '@compy/vm';
import { Module, Func, Block, Instr, Value, Reg, IrType, Sig, normalize, asUnsigned, bits, bytesOf, isFloatType, fmtInstr } from './ir';

/**
 * The IR interpreter: executes a Module directly, instruction by instruction,
 * over the same segmented Memory and libc the tree-walker uses. It exists for
 * two reasons: (1) it is the oracle that proves lowering and every
 * optimization pass preserve the program's meaning, and (2) it powers the
 * IDE's IR stepper, where students watch registers change as each
 * instruction fires.
 */

export type RVal = bigint | number;

export interface IrStepEvent {
  fn: string;
  block: string;
  index: number;
  instr: Instr;
  text: string;
  depth: number;
  /** Register values defined so far in this frame (by id). */
  regs: Map<number, RVal>;
  line?: number;
}

export interface IrRunOptions {
  memory?: Memory;
  console?: Console;
  syscalls?: Syscalls;
  vfs?: Vfs;
  natives?: Record<string, NativeFn>;
  argv?: string[];
  maxSteps?: number;
  /** Called before each IR instruction executes. */
  onInstr?: (ev: IrStepEvent) => void;
  /** Called when execution reaches an instruction from a new source line. */
  onLine?: (line: number, interp: IrInterp) => void;
  onFinish?: (interp: IrInterp) => void;
}

export interface IrRunResult {
  exitCode: number;
  faults: CFault[];
  leaks: { addr: number; size: number }[];
  fatal?: CFault;
  steps: number;
}

interface Frame {
  fn: Func;
  regs: Map<number, RVal>;
  locals: { name: string; addr: number; ct?: T.CType; ctype: string }[];
  line: number;
  savedTop: number;
}

interface FuncEntry {
  addr: number;
  name: string;
  fn?: Func;
  native?: NativeFn;
}

export function runIr(mod: Module, opts: IrRunOptions = {}): IrRunResult {
  return new IrInterp(mod, opts).run();
}

export class IrInterp implements NativeHost {
  readonly mem: Memory;
  readonly con: Console;
  readonly sys: Syscalls;
  readonly vfs: Vfs;
  private readonly natives: Record<string, NativeFn>;
  private readonly argv: string[];
  private readonly maxSteps: number;
  private steps = 0;
  private readonly frames: Frame[] = [];
  private readonly funcByName = new Map<string, FuncEntry>();
  private readonly funcByAddr = new Map<number, FuncEntry>();
  private readonly globalAddr = new Map<string, number>();
  private readonly stringAddr: number[] = [];
  private readonly stringPool = new Map<string, number>();
  private readonly atexitList: number[] = [];
  private nextFuncAddr: number;
  private readonly onInstr?: (ev: IrStepEvent) => void;
  private readonly onLine?: (line: number, interp: IrInterp) => void;
  private readonly onFinish?: (interp: IrInterp) => void;

  constructor(
    readonly mod: Module,
    opts: IrRunOptions,
  ) {
    this.vfs = opts.vfs ?? new Vfs();
    this.con = opts.console ?? new Console();
    this.mem = opts.memory ?? new Memory();
    this.sys = opts.syscalls ?? new Syscalls(this.vfs, this.con);
    this.natives = opts.natives ?? {};
    this.argv = opts.argv ?? ['program'];
    this.maxSteps = opts.maxSteps ?? 50_000_000;
    this.onInstr = opts.onInstr;
    this.onLine = opts.onLine;
    this.onFinish = opts.onFinish;
    this.nextFuncAddr = this.mem.segments.text.start + 16;
  }

  // -- setup -----------------------------------------------------------------

  run(): IrRunResult {
    this.loadImage();
    let exitCode = 0;
    let fatal: CFault | undefined;
    try {
      const main = this.funcByName.get('main');
      if (!main || !main.fn) throw new CRuntimeError('no main() function');
      const ret = this.callUser(main.fn, this.mainArgs(main.fn));
      exitCode = ret === undefined ? 0 : Number(normalize('i32', BigInt(typeof ret === 'number' ? Math.trunc(ret) : ret)));
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
      /* inspection must not crash the run */
    }
    const leaks = this.mem.leaks().map((b) => ({ addr: b.addr, size: b.size }));
    return { exitCode, faults: this.mem.warnings.slice(), leaks, fatal, steps: this.steps };
  }

  /** Place strings, globals, and function addresses in memory; apply relocations. */
  private loadImage(): void {
    for (const f of this.mod.functions) this.addFunc({ addr: this.allocFuncAddr(), name: f.name, fn: f });
    for (const name of this.mod.externs) {
      const native = this.natives[name];
      if (native && !this.funcByName.has(name)) this.addFunc({ addr: this.allocFuncAddr(), name, native });
    }
    for (const [name, native] of Object.entries(this.natives)) if (!this.funcByName.has(name)) this.addFunc({ addr: this.allocFuncAddr(), name, native });
    for (const s of this.mod.strings) this.stringAddr.push(this.internBytes(s));
    for (const g of this.mod.globals) {
      let addr: number;
      if (g.init) addr = g.readonly ? this.mem.allocRodata(g.init) : this.mem.allocData(g.init);
      else addr = this.mem.allocBss(g.size);
      this.globalAddr.set(g.name, addr);
    }
    for (const g of this.mod.globals) {
      const base = this.globalAddr.get(g.name)!;
      for (const r of g.relocs) {
        const target = this.resolveReloc(r.kind, r.ref) + r.addend;
        for (let k = 0; k < 4; k++) this.mem.poke(base + r.offset + k, (target >>> (8 * k)) & 0xff);
      }
    }
  }

  private resolveReloc(kind: 'global' | 'func' | 'str', ref: string | number): number {
    if (kind === 'str') return this.stringAddr[ref as number] ?? 0;
    if (kind === 'func') return this.funcByName.get(ref as string)?.addr ?? 0;
    return this.globalAddr.get(ref as string) ?? 0;
  }

  private allocFuncAddr(): number {
    const a = this.nextFuncAddr;
    this.nextFuncAddr += 16;
    return a;
  }
  private addFunc(e: FuncEntry): void {
    this.funcByName.set(e.name, e);
    this.funcByAddr.set(e.addr, e);
  }

  private mainArgs(fn: Func): RVal[] {
    if (fn.params.length === 0) return [];
    const argc = this.argv.length;
    const ptrs = this.argv.map((s) => this.internCString(s));
    const arr = this.mem.malloc(4 * (argc + 1));
    ptrs.forEach((p, i) => this.mem.writeU32(arr + i * 4, p));
    this.mem.writeU32(arr + argc * 4, 0);
    return [BigInt(argc), BigInt(arr)];
  }

  // -- execution -------------------------------------------------------------

  private callUser(fn: Func, args: RVal[]): RVal | undefined {
    if (this.frames.length > 6000) throw new CFault('stack-overflow', this.mem.stackTop, 0, 'call depth exceeded');
    const frame: Frame = { fn, regs: new Map(), locals: [], line: fn.line ?? 0, savedTop: this.mem.stackTop };
    fn.params.forEach((p, i) => frame.regs.set(p.id, coerce(p.type, args[i] ?? 0n)));
    this.frames.push(frame);
    try {
      return this.execFunction(frame);
    } finally {
      this.frames.pop();
      this.mem.popStackTo(frame.savedTop);
    }
  }

  private execFunction(frame: Frame): RVal | undefined {
    const fn = frame.fn;
    const blocks = new Map<string, Block>();
    for (const b of fn.blocks) blocks.set(b.name, b);
    let block = fn.blocks[0]!;
    let prev = '';
    let lastLine = -1;
    for (;;) {
      // Phis: parallel copy on block entry.
      let pc = 0;
      const phiVals: [number, RVal][] = [];
      while (pc < block.instrs.length && block.instrs[pc]!.op === 'phi') {
        const phi = block.instrs[pc]! as Extract<Instr, { op: 'phi' }>;
        const inc = phi.incoming.find((x) => x.block === prev);
        if (!inc) throw new CRuntimeError(`phi in ${block.name} has no incoming value from ${prev}`);
        phiVals.push([phi.dst.id, coerce(phi.dst.type, this.read(frame, inc.value))]);
        pc++;
      }
      for (const [id, v] of phiVals) frame.regs.set(id, v);
      let next: string | null = null;
      for (; pc < block.instrs.length; pc++) {
        const ins = block.instrs[pc]!;
        if (++this.steps > this.maxSteps) throw new CRuntimeError('execution step limit exceeded (infinite loop?)');
        if (ins.line !== undefined && ins.line !== lastLine) {
          lastLine = ins.line;
          frame.line = ins.line;
          this.onLine?.(ins.line, this);
        }
        if (this.onInstr) this.onInstr({ fn: fn.name, block: block.name, index: pc, instr: ins, text: fmtInstr(ins), depth: this.frames.length, regs: frame.regs, line: ins.line });
        switch (ins.op) {
          case 'bin': frame.regs.set(ins.dst.id, this.binop(ins.opc, ins.dst.type, this.read(frame, ins.a), this.read(frame, ins.b))); break;
          case 'cmp': frame.regs.set(ins.dst.id, this.cmpop(ins.opc, ins.a.type, this.read(frame, ins.a), this.read(frame, ins.b))); break;
          case 'cast': frame.regs.set(ins.dst.id, castVal(ins.opc, ins.src.type, ins.dst.type, this.read(frame, ins.src))); break;
          case 'load': frame.regs.set(ins.dst.id, this.loadMem(Number(this.read(frame, ins.addr)), ins.dst.type)); break;
          case 'store': this.storeMem(Number(this.read(frame, ins.addr)), ins.val.type, this.read(frame, ins.val)); break;
          case 'alloca': {
            const size = Math.max(1, Number(this.read(frame, ins.size)));
            const addr = this.mem.pushStack(size);
            frame.regs.set(ins.dst.id, BigInt(addr));
            frame.locals.push({ name: ins.name, addr, ct: ins.ct, ctype: ins.ctype });
            break;
          }
          case 'global': frame.regs.set(ins.dst.id, BigInt(this.globalAddr.get(ins.name) ?? 0)); break;
          case 'funcaddr': {
            const f = this.funcByName.get(ins.name);
            if (!f) throw new CRuntimeError(`'${ins.name}' is not defined`);
            frame.regs.set(ins.dst.id, BigInt(f.addr));
            break;
          }
          case 'str': frame.regs.set(ins.dst.id, BigInt(this.stringAddr[ins.id] ?? 0)); break;
          case 'ptradd': {
            const base = Number(this.read(frame, ins.base));
            const idx = Number(normalize('i32', BigInt(this.read(frame, ins.index) as bigint)));
            frame.regs.set(ins.dst.id, BigInt((base + idx * ins.scale) >>> 0));
            break;
          }
          case 'select': {
            const c = this.read(frame, ins.cond);
            frame.regs.set(ins.dst.id, c !== 0n && c !== 0 ? this.read(frame, ins.a) : this.read(frame, ins.b));
            break;
          }
          case 'call': {
            const args = ins.args.map((a) => this.read(frame, a));
            const r = typeof ins.callee === 'string' ? this.callByName(ins.callee, args, ins.sig) : this.callByAddr(Number(this.read(frame, ins.callee)), args, ins.sig);
            if (ins.dst) frame.regs.set(ins.dst.id, coerce(ins.dst.type, r ?? 0n));
            break;
          }
          case 'memcpy': this.mem.copy(Number(this.read(frame, ins.dst)), Number(this.read(frame, ins.src)), Number(this.read(frame, ins.len))); break;
          case 'memset': this.mem.fill(Number(this.read(frame, ins.dst)), Number(this.read(frame, ins.byte)), Number(this.read(frame, ins.len))); break;
          case 'phi': throw new CRuntimeError('phi not at block start');
          case 'br': next = ins.target; break;
          case 'condbr': {
            const c = this.read(frame, ins.cond);
            next = c !== 0n && c !== 0 ? ins.then : ins.else;
            break;
          }
          case 'switch': {
            const v = normalize('i32', BigInt(this.read(frame, ins.val) as bigint));
            next = ins.default;
            for (const c of ins.cases) if (c.value === v) { next = c.target; break; }
            break;
          }
          case 'ret': return ins.val ? this.read(frame, ins.val) : undefined;
          case 'unreachable': throw new CRuntimeError(`reached unreachable code in ${fn.name}`);
        }
        if (next !== null) break;
      }
      if (next === null) throw new CRuntimeError(`block ${block.name} in ${fn.name} fell off the end`);
      prev = block.name;
      const nb = blocks.get(next);
      if (!nb) throw new CRuntimeError(`branch to unknown block ${next}`);
      block = nb;
    }
  }

  private read(frame: Frame, v: Value): RVal {
    if (v.kind === 'const') return isFloatType(v.type) ? v.f : v.i;
    const r = frame.regs.get(v.id);
    if (r === undefined) throw new CRuntimeError(`use of undefined register %${v.id} in ${frame.fn.name}`);
    return r;
  }

  private binop(opc: string, type: IrType, a: RVal, b: RVal): RVal {
    if (isFloatType(type)) {
      const x = Number(a);
      const y = Number(b);
      let r: number;
      switch (opc) {
        case 'fadd': r = x + y; break;
        case 'fsub': r = x - y; break;
        case 'fmul': r = x * y; break;
        case 'fdiv': r = x / y; break;
        default: throw new CRuntimeError(`bad float op ${opc}`);
      }
      return type === 'f32' ? Math.fround(r) : r;
    }
    const x = BigInt(a as bigint);
    const y = BigInt(b as bigint);
    const w = BigInt(bits(type));
    switch (opc) {
      case 'add': return normalize(type, x + y);
      case 'sub': return normalize(type, x - y);
      case 'mul': return normalize(type, x * y);
      case 'sdiv': if (y === 0n) throw new CRuntimeError('division by zero'); return normalize(type, x / y);
      case 'udiv': if (y === 0n) throw new CRuntimeError('division by zero'); return normalize(type, asUnsigned(type, x) / asUnsigned(type, y));
      case 'srem': if (y === 0n) throw new CRuntimeError('division by zero'); return normalize(type, x % y);
      case 'urem': if (y === 0n) throw new CRuntimeError('division by zero'); return normalize(type, asUnsigned(type, x) % asUnsigned(type, y));
      case 'and': return normalize(type, x & y);
      case 'or': return normalize(type, x | y);
      case 'xor': return normalize(type, x ^ y);
      case 'shl': return normalize(type, x << (asUnsigned(type, y) & (w - 1n)));
      case 'lshr': return normalize(type, asUnsigned(type, x) >> (asUnsigned(type, y) & (w - 1n)));
      case 'ashr': return normalize(type, x >> (asUnsigned(type, y) & (w - 1n)));
    }
    throw new CRuntimeError(`bad int op ${opc}`);
  }

  private cmpop(opc: string, type: IrType, a: RVal, b: RVal): bigint {
    let r: boolean;
    if (isFloatType(type)) {
      const x = Number(a);
      const y = Number(b);
      switch (opc) {
        case 'oeq': r = x === y; break;
        case 'one': r = x !== y; break;
        case 'olt': r = x < y; break;
        case 'ole': r = x <= y; break;
        case 'ogt': r = x > y; break;
        case 'oge': r = x >= y; break;
        default: r = false;
      }
      return r ? 1n : 0n;
    }
    const sx = BigInt(a as bigint);
    const sy = BigInt(b as bigint);
    const ux = asUnsigned(type, sx);
    const uy = asUnsigned(type, sy);
    switch (opc) {
      case 'eq': r = ux === uy; break;
      case 'ne': r = ux !== uy; break;
      case 'slt': r = sx < sy; break;
      case 'sle': r = sx <= sy; break;
      case 'sgt': r = sx > sy; break;
      case 'sge': r = sx >= sy; break;
      case 'ult': r = ux < uy; break;
      case 'ule': r = ux <= uy; break;
      case 'ugt': r = ux > uy; break;
      case 'uge': r = ux >= uy; break;
      default: r = false;
    }
    return r ? 1n : 0n;
  }

  private loadMem(addr: number, type: IrType): RVal {
    switch (type) {
      case 'i1': case 'i8': return BigInt(this.mem.readI8(addr));
      case 'i16': return BigInt(this.mem.readI16(addr));
      case 'i32': return BigInt(this.mem.readI32(addr));
      case 'ptr': return BigInt(this.mem.readU32(addr));
      case 'i64': return this.mem.readI64(addr);
      case 'f32': return this.mem.readF32(addr);
      case 'f64': return this.mem.readF64(addr);
      case 'void': return 0n;
    }
  }

  private storeMem(addr: number, type: IrType, v: RVal): void {
    switch (type) {
      case 'i1': case 'i8': this.mem.writeU8(addr, Number(BigInt.asUintN(8, v as bigint))); break;
      case 'i16': this.mem.writeI16(addr, Number(BigInt.asIntN(16, v as bigint))); break;
      case 'i32': case 'ptr': this.mem.writeI32(addr, Number(BigInt.asIntN(32, v as bigint))); break;
      case 'i64': this.mem.writeI64(addr, BigInt.asIntN(64, v as bigint)); break;
      case 'f32': this.mem.writeF32(addr, v as number); break;
      case 'f64': this.mem.writeF64(addr, v as number); break;
      case 'void': break;
    }
  }

  // -- calls -----------------------------------------------------------------

  private callByName(name: string, args: RVal[], sig: Sig): RVal | undefined {
    const e = this.funcByName.get(name);
    if (!e) throw new CRuntimeError(`call to undefined function '${name}'`);
    return this.invoke(e, args, sig);
  }
  private callByAddr(addr: number, args: RVal[], sig: Sig): RVal | undefined {
    const e = this.funcByAddr.get(addr);
    if (!e) throw new CFault('segfault', addr, 0, 'call through an invalid function pointer');
    return this.invoke(e, args, sig);
  }
  private invoke(e: FuncEntry, args: RVal[], sig: Sig): RVal | undefined {
    if (e.fn) return this.callUser(e.fn, args);
    if (e.native) {
      const vals = args.map((a, i) => toVal(sig.params[i] ?? 'i32', a));
      const r = e.native(this, vals);
      if (!r) return undefined;
      return fromVal(sig.ret, r);
    }
    return undefined;
  }

  // -- NativeHost --------------------------------------------------------------

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
  callFunctionPointer(addr: number, args: Val[]): Val | null {
    const e = this.funcByAddr.get(addr);
    if (!e) throw new CFault('segfault', addr, 0, 'call through an invalid function pointer');
    if (e.native) return e.native(this, args);
    if (!e.fn) return null;
    const rv = this.callUser(e.fn, args.map((a) => (a.type.kind === 'float' ? a.f : a.i)));
    if (rv === undefined) return null;
    return toVal(e.fn.ret, rv);
  }
  callDepth(): number {
    return this.frames.length;
  }
  private runAtexit(): void {
    for (let i = this.atexitList.length - 1; i >= 0; i--) {
      try {
        this.callFunctionPointer(this.atexitList[i]!, []);
      } catch {
        /* ignore */
      }
    }
  }

  // -- inspection (for the IDE) ----------------------------------------------

  callStack(): { name: string; line: number }[] {
    return this.frames.map((f) => ({ name: f.fn.name, line: f.line }));
  }

  frameVars(): VarView[] {
    const f = this.frames[this.frames.length - 1];
    if (!f) return [];
    return f.locals.map((l) => ({ name: l.name, type: l.ctype, addr: l.addr, value: l.ct ? this.formatAt(l.addr, l.ct) : '?' }));
  }

  globalVars(): VarView[] {
    const out: VarView[] = [];
    for (const g of this.mod.globals) {
      const addr = this.globalAddr.get(g.name);
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
      if (type.kind === 'struct' || type.kind === 'union') {
        return '{' + type.fields.map((f) => `${f.name}=${this.formatAt(addr + f.offset, f.type)}`).join(', ') + '}';
      }
      if (type.kind === 'float') return String(type.bytes === 4 ? this.mem.readF32(addr) : this.mem.readF64(addr));
      if (type.kind === 'pointer' || type.kind === 'function') {
        const p = this.mem.readU32(addr);
        return p === 0 ? 'NULL' : '0x' + p.toString(16);
      }
      if (type.kind === 'bool') return String(this.mem.readU8(addr));
      if (type.kind === 'int') {
        switch (type.bytes) {
          case 1: return String(type.signed ? this.mem.readI8(addr) : this.mem.readU8(addr));
          case 2: return String(type.signed ? this.mem.readI16(addr) : this.mem.readU16(addr));
          case 4: return String(type.signed ? this.mem.readI32(addr) : this.mem.readU32(addr));
          case 8: return String(type.signed ? this.mem.readI64(addr) : this.mem.readU64(addr));
        }
      }
      return String(this.mem.readI32(addr));
    } catch {
      return '<?>';
    }
  }
}

// -- value conversion ----------------------------------------------------------

function coerce(type: IrType, v: RVal): RVal {
  if (isFloatType(type)) return type === 'f32' ? Math.fround(Number(v)) : Number(v);
  return normalize(type, typeof v === 'number' ? BigInt(Math.trunc(v)) : v);
}

export function castVal(opc: string, from: IrType, to: IrType, v: RVal): RVal {
  switch (opc) {
    case 'trunc': case 'sext': case 'bitcast': case 'ptrtoint': case 'inttoptr':
      return normalize(to, v as bigint);
    case 'zext':
      return normalize(to, asUnsigned(from, v as bigint));
    case 'sitofp': return to === 'f32' ? Math.fround(Number(v)) : Number(v);
    case 'uitofp': return to === 'f32' ? Math.fround(Number(asUnsigned(from, v as bigint))) : Number(asUnsigned(from, v as bigint));
    case 'fptosi': case 'fptoui': {
      const n = Number(v);
      if (!Number.isFinite(n)) return 0n;
      return normalize(to, BigInt(Math.trunc(n)));
    }
    case 'fpext': return Number(v);
    case 'fptrunc': return Math.fround(Number(v));
  }
  throw new CRuntimeError(`bad cast ${opc}`);
}

export function cTypeOf(t: IrType): T.CType {
  switch (t) {
    case 'i1': return T.INT;
    case 'i8': return T.CHAR;
    case 'i16': return T.SHORT;
    case 'i32': return T.INT;
    case 'i64': return T.LLONG;
    case 'f32': return T.FLOAT;
    case 'f64': return T.DOUBLE;
    case 'ptr': return T.pointerTo(T.VOID);
    case 'void': return T.VOID;
  }
}

export function toVal(t: IrType, v: RVal): Val {
  const ct = cTypeOf(t);
  if (isFloatType(t)) return floatVal(ct, Number(v));
  if (t === 'ptr') return ptrVal(ct, Number(v));
  return intVal(ct, typeof v === 'number' ? BigInt(Math.trunc(v)) : v);
}

export function fromVal(t: IrType, v: Val): RVal {
  if (isFloatType(t)) return t === 'f32' ? Math.fround(v.type.kind === 'float' ? v.f : Number(v.i)) : v.type.kind === 'float' ? v.f : Number(v.i);
  if (v.type.kind === 'float') return normalize(t, BigInt(Math.trunc(v.f)));
  return normalize(t, v.i);
}

export { bytesOf };
