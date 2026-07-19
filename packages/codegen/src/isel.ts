import { Module, Func, Block, Instr, Value, Reg, IrType, Sig, isFloatType, bits, successors, terminatorOf, predecessors, usesOf, asUnsigned } from '@compy/ir';
import { MInstr, MBlock, MFunc, MModule, MReg, FloatConst, ARG_REGS, FARG_REGS } from './mir';

/**
 * Instruction selection: each IR instruction becomes one or a few RISC-V
 * instructions operating on virtual registers. This stage also fixes the
 * calling convention (which arguments travel in a0–a7 / fa0–fa7 and which
 * on the stack), eliminates phi nodes by inserting copies on the incoming
 * edges, and fuses a compare with the branch that consumes it.
 *
 * Target: RV32IM with the F and D extensions. 64-bit integers live in
 * register pairs; their multiply, divide, shift, and compare go through
 * small runtime helpers, exactly as gcc does on rv32.
 */

export interface ArgLoc {
  kind: 'ireg' | 'ipair' | 'freg' | 'stack';
  reg?: string;
  hi?: string;
  offset?: number;
  size?: number;
  type: IrType;
}

/** The ILP32 calling convention. `fixed` = number of prototyped params. */
export function assignArgs(params: IrType[], fixed: number): { locs: ArgLoc[]; stackBytes: number } {
  let gi = 0;
  let fi = 0;
  let off = 0;
  const locs: ArgLoc[] = [];
  const stackSlot = (size: number, align: number): number => {
    off = Math.ceil(off / align) * align;
    const o = off;
    off += size;
    return o;
  };
  params.forEach((t, k) => {
    const variadicFloat = isFloatType(t) && k >= fixed;
    if (t === 'i64' || variadicFloat) {
      if (gi % 2 === 1) gi++;
      if (gi + 1 < 8) {
        locs.push({ kind: 'ipair', reg: ARG_REGS[gi]!, hi: ARG_REGS[gi + 1]!, type: t });
        gi += 2;
      } else {
        gi = 8;
        locs.push({ kind: 'stack', offset: stackSlot(8, 8), size: 8, type: t });
      }
    } else if (isFloatType(t)) {
      if (fi < 8) locs.push({ kind: 'freg', reg: FARG_REGS[fi++]!, type: t });
      else locs.push({ kind: 'stack', offset: stackSlot(t === 'f64' ? 8 : 4, t === 'f64' ? 8 : 4), size: t === 'f64' ? 8 : 4, type: t });
    } else if (gi < 8) {
      locs.push({ kind: 'ireg', reg: ARG_REGS[gi++]!, type: t });
    } else {
      locs.push({ kind: 'stack', offset: stackSlot(4, 4), size: 4, type: t });
    }
  });
  return { locs, stackBytes: Math.ceil(off / 16) * 16 };
}

export function select(mod: Module): MModule {
  const out: MModule = { functions: [], floatConsts: [] };
  for (const f of mod.functions) out.functions.push(new FuncSel(f, out).run());
  return out;
}

const I64_HELPERS: Record<string, string> = {
  mul: '__muldi3', sdiv: '__divdi3', udiv: '__udivdi3', srem: '__moddi3', urem: '__umoddi3',
  shl: '__ashldi3', lshr: '__lshrdi3', ashr: '__ashrdi3',
};

class FuncSel {
  private readonly m: MFunc;
  private cur!: MBlock;
  private nextTmp = 0;
  private callSeq = 0;
  private readonly useCount = new Map<number, number>();
  private readonly cmpDefs = new Map<number, Extract<Instr, { op: 'cmp' }>>();
  private readonly preds: Map<string, string[]>;
  private curLine: number | undefined;
  private extraBlocks = 0;

  constructor(
    private readonly f: Func,
    private readonly mod: MModule,
  ) {
    this.m = { name: f.name, blocks: [], vregs: new Map(), allocas: [], outgoingArgBytes: 0, hasDynamicAlloca: false, line: f.line, csig: f.csig };
    this.preds = predecessors(f);
    for (const b of f.blocks) for (const i of b.instrs) for (const u of usesOf(i)) if (u.kind === 'reg') this.useCount.set(u.id, (this.useCount.get(u.id) ?? 0) + 1);
  }

  run(): MFunc {
    const entry = this.newBlock(this.f.name);
    this.cur = entry;
    this.curLine = this.f.line;
    this.lowerParams();
    const blockLabel = new Map<string, string>();
    this.f.blocks.forEach((b, k) => blockLabel.set(b.name, k === 0 ? this.f.name : this.label(b.name)));
    this.f.blocks.forEach((b, k) => {
      if (k === 0) this.cur = entry;
      else this.cur = this.newBlock(blockLabel.get(b.name)!);
      this.lowerBlock(b, blockLabel);
    });
    return this.m;
  }

  // -- plumbing ----------------------------------------------------------------

  private label(block: string): string {
    return `.L${this.f.name}.${block}`;
  }
  private newBlock(name: string): MBlock {
    const b: MBlock = { name, instrs: [] };
    this.m.blocks.push(b);
    return b;
  }
  private emit(i: MInstr): MInstr {
    if (i.line === undefined && this.curLine !== undefined) i.line = this.curLine;
    this.cur.instrs.push(i);
    return i;
  }
  private vreg(r: Reg): MReg {
    const name = isFloatType(r.type) ? `fv${r.id}` : `v${r.id}`;
    this.m.vregs.set(name, isFloatType(r.type) ? 'float' : 'int');
    return name;
  }
  private pair(r: Reg): [MReg, MReg] {
    const lo = `v${r.id}l`;
    const hi = `v${r.id}h`;
    this.m.vregs.set(lo, 'int');
    this.m.vregs.set(hi, 'int');
    return [lo, hi];
  }
  private tmp(): MReg {
    const n = `vt${this.nextTmp++}`;
    this.m.vregs.set(n, 'int');
    return n;
  }
  private ftmp(): MReg {
    const n = `fvt${this.nextTmp++}`;
    this.m.vregs.set(n, 'float');
    return n;
  }

  /** An integer value in a register (`zero` for the constant 0). */
  private reg(v: Value): MReg {
    if (v.kind === 'reg') return v.type === 'i64' ? this.pair(v)[0] : this.vreg(v);
    const n = Number(asUnsigned('i32', v.i) | 0n) | 0;
    if (n === 0) return 'zero';
    const t = this.tmp();
    this.emit({ op: 'li', rd: t, imm: n });
    return t;
  }
  private freg(v: Value): MReg {
    if (v.kind === 'reg') return this.vreg(v);
    const t = this.ftmp();
    const label = this.floatConst(v.type, v.f);
    const a = this.tmp();
    this.emit({ op: 'la', rd: a, target: label });
    this.emit({ op: v.type === 'f32' ? 'flw' : 'fld', rd: t, rs1: a, imm: 0 });
    return t;
  }
  private pairOf(v: Value): [MReg, MReg] {
    if (v.kind === 'reg') return this.pair(v);
    const u = asUnsigned('i64', v.i);
    const lo = Number(u & 0xffffffffn) | 0;
    const hi = Number((u >> 32n) & 0xffffffffn) | 0;
    const l = this.tmp();
    const h = this.tmp();
    this.emit({ op: 'li', rd: l, imm: lo });
    this.emit({ op: 'li', rd: h, imm: hi });
    return [l, h];
  }
  private floatConst(type: IrType, value: number): string {
    const buf = new DataView(new ArrayBuffer(8));
    if (type === 'f32') buf.setFloat32(0, value, true);
    else buf.setFloat64(0, value, true);
    const key = type === 'f32' ? `s${buf.getUint32(0, true)}` : `d${buf.getUint32(0, true)}_${buf.getUint32(4, true)}`;
    const existing = this.mod.floatConsts.find((c) => c.label.endsWith('_' + key));
    if (existing) return existing.label;
    const fc: FloatConst = { label: `.LC${this.mod.floatConsts.length}_${key}`, bits: type === 'f32' ? 32 : 64, value };
    this.mod.floatConsts.push(fc);
    return fc.label;
  }
  private fits12(n: number): boolean {
    return n >= -2048 && n <= 2047;
  }
  /** rd = rs1 + imm (any imm). */
  private addImm(rd: MReg, rs1: MReg, imm: number): void {
    if (this.fits12(imm)) this.emit({ op: 'addi', rd, rs1, imm });
    else {
      const t = this.tmp();
      this.emit({ op: 'li', rd: t, imm });
      this.emit({ op: 'add', rd, rs1, rs2: t });
    }
  }

  // -- parameters ----------------------------------------------------------------

  private lowerParams(): void {
    const { locs } = assignArgs(this.f.params.map((p) => p.type), this.f.params.length);
    this.f.params.forEach((p, k) => {
      const loc = locs[k]!;
      switch (loc.kind) {
        case 'ireg': this.emit({ op: 'mv', rd: this.vreg(p), rs1: loc.reg!, comment: `param ${this.f.paramNames[k] ?? ''}` }); break;
        case 'freg': this.emit({ op: p.type === 'f32' ? 'fmv.s' : 'fmv.d', rd: this.vreg(p), rs1: loc.reg!, comment: `param ${this.f.paramNames[k] ?? ''}` }); break;
        case 'ipair': {
          const [lo, hi] = this.pair(p);
          this.emit({ op: 'mv', rd: lo, rs1: loc.reg!, comment: `param ${this.f.paramNames[k] ?? ''} (lo)` });
          this.emit({ op: 'mv', rd: hi, rs1: loc.hi! });
          break;
        }
        case 'stack': {
          // Caller placed it at its sp; after our prologue that is fp + offset.
          if (p.type === 'i64') {
            const [lo, hi] = this.pair(p);
            this.emit({ op: 'lw', rd: lo, rs1: 's0', imm: 0, stackParam: loc.offset });
            this.emit({ op: 'lw', rd: hi, rs1: 's0', imm: 0, stackParam: loc.offset! + 4 });
          } else if (isFloatType(p.type)) {
            this.emit({ op: p.type === 'f32' ? 'flw' : 'fld', rd: this.vreg(p), rs1: 's0', imm: 0, stackParam: loc.offset });
          } else this.emit({ op: 'lw', rd: this.vreg(p), rs1: 's0', imm: 0, stackParam: loc.offset, comment: `param ${this.f.paramNames[k] ?? ''}` });
          break;
        }
      }
    });
  }

  // -- blocks ----------------------------------------------------------------------

  private lowerBlock(b: Block, blockLabel: Map<string, string>): void {
    const term = terminatorOf(b);
    const body = term ? b.instrs.slice(0, -1) : b.instrs;
    // Which cmp results feed only the terminator (fusable)?
    const fusable = new Set<number>();
    if (term && term.op === 'condbr' && term.cond.kind === 'reg' && this.useCount.get(term.cond.id) === 1) {
      const def = body.find((i) => i.op === 'cmp' && i.dst.id === (term.cond as Reg).id) as Extract<Instr, { op: 'cmp' }> | undefined;
      if (def && !isFloatType(def.a.type) && def.a.type !== 'i64') {
        fusable.add(def.dst.id);
        this.cmpDefs.set(def.dst.id, def);
      }
    }
    for (const i of body) {
      this.curLine = i.line ?? this.curLine;
      if (i.op === 'cmp' && fusable.has(i.dst.id)) continue;
      this.lowerInstr(i);
    }
    if (!term) {
      this.emit({ op: 'ret' });
      return;
    }
    this.curLine = term.line ?? this.curLine;
    // Phi copies for each successor (on the edge if the edge is critical).
    const succs = successors(term);
    const edgeLabel = new Map<string, string>();
    for (const s of succs) {
      const sb = this.f.blocks.find((x) => x.name === s)!;
      const phis = sb.instrs.filter((x): x is Extract<Instr, { op: 'phi' }> => x.op === 'phi');
      if (phis.length === 0) continue;
      const copies: [Reg, Value][] = phis.map((p) => [p.dst, p.incoming.find((x) => x.block === b.name)!.value]);
      const critical = succs.length > 1 && (this.preds.get(s)?.length ?? 0) > 1;
      if (critical) {
        const saved = this.cur;
        const eb = this.newBlock(this.label(`${b.name}.to.${s}`));
        this.cur = eb;
        this.parallelCopy(copies);
        this.emit({ op: 'j', target: blockLabel.get(s)! });
        this.cur = saved;
        edgeLabel.set(s, eb.name);
      } else {
        this.parallelCopy(copies);
      }
    }
    const L = (s: string): string => edgeLabel.get(s) ?? blockLabel.get(s)!;
    switch (term.op) {
      case 'br': this.emit({ op: 'j', target: L(term.target) }); break;
      case 'condbr': {
        const cmp = term.cond.kind === 'reg' ? this.cmpDefs.get(term.cond.id) : undefined;
        if (cmp && fusable.has(cmp.dst.id)) this.fusedBranch(cmp, L(term.then), L(term.else));
        else {
          this.emit({ op: 'bnez', rs1: this.reg(term.cond), target: L(term.then) });
          this.emit({ op: 'j', target: L(term.else) });
        }
        break;
      }
      case 'switch': {
        const v = this.reg(term.val);
        for (const c of term.cases) {
          const t = this.tmp();
          this.emit({ op: 'li', rd: t, imm: Number(c.value) | 0 });
          this.emit({ op: 'beq', rs1: v, rs2: t, target: L(c.target) });
        }
        this.emit({ op: 'j', target: L(term.default) });
        break;
      }
      case 'ret': {
        if (term.val) {
          const v = term.val;
          if (v.type === 'i64') {
            const [lo, hi] = this.pairOf(v);
            this.emit({ op: 'mv', rd: 'a0', rs1: lo });
            this.emit({ op: 'mv', rd: 'a1', rs1: hi });
          } else if (isFloatType(v.type)) this.emit({ op: v.type === 'f32' ? 'fmv.s' : 'fmv.d', rd: 'fa0', rs1: this.freg(v) });
          else this.emit({ op: 'mv', rd: 'a0', rs1: this.reg(v) });
        }
        this.emit({ op: 'ret' });
        break;
      }
      case 'unreachable': this.emit({ op: 'ebreak', comment: 'unreachable' }); break;
    }
  }

  /** Sequentialize a set of parallel copies (phi semantics). */
  private parallelCopy(copies: [Reg, Value][]): void {
    type Copy = { dst: MReg; src: MReg | Value; cls: 'int' | 'float' };
    const pending: Copy[] = [];
    for (const [dst, src] of copies) {
      if (dst.type === 'i64') {
        const [dl, dh] = this.pair(dst);
        if (src.kind === 'reg') {
          const [sl, sh] = this.pair(src);
          pending.push({ dst: dl, src: sl, cls: 'int' }, { dst: dh, src: sh, cls: 'int' });
        } else {
          const u = asUnsigned('i64', src.i);
          pending.push({ dst: dl, src: { kind: 'const', type: 'i32', i: u & 0xffffffffn, f: 0 }, cls: 'int' });
          pending.push({ dst: dh, src: { kind: 'const', type: 'i32', i: (u >> 32n) & 0xffffffffn, f: 0 }, cls: 'int' });
        }
      } else if (isFloatType(dst.type)) {
        pending.push({ dst: this.vreg(dst), src: src.kind === 'reg' ? this.vreg(src) : src, cls: 'float' });
      } else {
        pending.push({ dst: this.vreg(dst), src: src.kind === 'reg' ? this.vreg(src) : src, cls: 'int' });
      }
    }
    const isReg = (s: MReg | Value): s is MReg => typeof s === 'string';
    let work = pending.filter((c) => !(isReg(c.src) && c.src === c.dst));
    while (work.length) {
      const idx = work.findIndex((c) => !work.some((o) => o !== c && isReg(o.src) && o.src === c.dst));
      if (idx >= 0) {
        const c = work[idx]!;
        this.copy(c.dst, c.src, c.cls);
        work.splice(idx, 1);
        continue;
      }
      // Every destination is still needed as a source: break the cycle with a temp.
      const c = work[0]!;
      const t = c.cls === 'float' ? this.ftmp() : this.tmp();
      this.copy(t, c.src, c.cls);
      for (const o of work) if (isReg(o.src) && o.src === c.src) o.src = t;
    }
  }
  private copy(dst: MReg, src: MReg | Value, cls: 'int' | 'float'): void {
    if (typeof src === 'string') {
      this.emit({ op: cls === 'float' ? 'fmv.d' : 'mv', rd: dst, rs1: src, comment: 'phi' });
    } else if (cls === 'float') {
      this.emit({ op: 'fmv.d', rd: dst, rs1: this.freg(src), comment: 'phi' });
    } else if (src.kind === 'const') {
      this.emit({ op: 'li', rd: dst, imm: Number(asUnsigned('i32', src.i)) | 0, comment: 'phi' });
    }
  }

  private fusedBranch(cmp: Extract<Instr, { op: 'cmp' }>, thenL: string, elseL: string): void {
    const a = this.reg(cmp.a);
    const b = this.reg(cmp.b);
    let op: string;
    let rs1 = a;
    let rs2 = b;
    switch (cmp.opc) {
      case 'eq': op = 'beq'; break;
      case 'ne': op = 'bne'; break;
      case 'slt': op = 'blt'; break;
      case 'sge': op = 'bge'; break;
      case 'sgt': op = 'blt'; [rs1, rs2] = [b, a]; break;
      case 'sle': op = 'bge'; [rs1, rs2] = [b, a]; break;
      case 'ult': op = 'bltu'; break;
      case 'uge': op = 'bgeu'; break;
      case 'ugt': op = 'bltu'; [rs1, rs2] = [b, a]; break;
      case 'ule': op = 'bgeu'; [rs1, rs2] = [b, a]; break;
      default: op = 'bne';
    }
    this.emit({ op, rs1, rs2, target: thenL });
    this.emit({ op: 'j', target: elseL });
  }

  // -- instructions ------------------------------------------------------------------

  private lowerInstr(i: Instr): void {
    switch (i.op) {
      case 'bin': return this.lowerBin(i);
      case 'cmp': return this.lowerCmp(i);
      case 'cast': return this.lowerCast(i);
      case 'load': return this.lowerLoad(i.dst, this.reg(i.addr), 0);
      case 'store': return this.lowerStore(i.val, this.reg(i.addr), 0);
      case 'alloca': {
        const dst = this.vreg(i.dst);
        if (i.size.kind === 'const') {
          const name = `${i.name}#${i.dst.id}`;
          this.m.allocas.push({ name, size: Number(i.size.i), align: i.align, ctype: i.ctype });
          this.emit({ op: 'addi', rd: dst, rs1: 's0', imm: 0, frameSlot: name, comment: `&${i.name}` });
        } else {
          this.m.hasDynamicAlloca = true;
          const sz = this.reg(i.size);
          const t = this.tmp();
          this.emit({ op: 'addi', rd: t, rs1: sz, imm: 15 });
          this.emit({ op: 'andi', rd: t, rs1: t, imm: -16 });
          this.emit({ op: 'sub', rd: 'sp', rs1: 'sp', rs2: t, comment: `VLA ${i.name}` });
          this.emit({ op: 'mv', rd: dst, rs1: 'sp' });
        }
        return;
      }
      case 'global': this.emit({ op: 'la', rd: this.vreg(i.dst), target: i.name }); return;
      case 'funcaddr': this.emit({ op: 'la', rd: this.vreg(i.dst), target: i.name }); return;
      case 'str': this.emit({ op: 'la', rd: this.vreg(i.dst), target: `.str${i.id}` }); return;
      case 'ptradd': {
        const dst = this.vreg(i.dst);
        const base = this.reg(i.base);
        if (i.index.kind === 'const') {
          this.addImm(dst, base, Number(i.index.i) * i.scale);
          return;
        }
        const idx = this.reg(i.index);
        const k = Math.log2(i.scale);
        if (i.scale === 1) this.emit({ op: 'add', rd: dst, rs1: base, rs2: idx });
        else if (Number.isInteger(k)) {
          const t = this.tmp();
          this.emit({ op: 'slli', rd: t, rs1: idx, imm: k });
          this.emit({ op: 'add', rd: dst, rs1: base, rs2: t });
        } else {
          const t = this.tmp();
          const s = this.tmp();
          this.emit({ op: 'li', rd: s, imm: i.scale });
          this.emit({ op: 'mul', rd: t, rs1: idx, rs2: s });
          this.emit({ op: 'add', rd: dst, rs1: base, rs2: t });
        }
        return;
      }
      case 'select': {
        const c = this.reg(i.cond);
        const lt = this.label(`sel${this.extraBlocks}.t`);
        const lf = this.label(`sel${this.extraBlocks}.f`);
        const le = this.label(`sel${this.extraBlocks}.end`);
        this.extraBlocks++;
        this.emit({ op: 'bnez', rs1: c, target: lt });
        this.emit({ op: 'j', target: lf });
        this.cur = this.newBlock(lt);
        this.moveValue(i.dst, i.a);
        this.emit({ op: 'j', target: le });
        this.cur = this.newBlock(lf);
        this.moveValue(i.dst, i.b);
        this.emit({ op: 'j', target: le });
        this.cur = this.newBlock(le);
        return;
      }
      case 'call': return this.lowerCall(i);
      case 'memcpy':
        this.callNative('memcpy', { ret: 'ptr', params: ['ptr', 'ptr', 'i32'], variadic: false, fixed: 3 }, [i.dst, i.src, i.len], null);
        return;
      case 'memset':
        this.callNative('memset', { ret: 'ptr', params: ['ptr', 'i32', 'i32'], variadic: false, fixed: 3 }, [i.dst, i.byte, i.len], null);
        return;
      case 'phi': return; // eliminated via edge copies
      default:
        throw new Error(`isel: unexpected instruction ${i.op}`);
    }
  }

  private moveValue(dst: Reg, src: Value): void {
    if (dst.type === 'i64') {
      const [dl, dh] = this.pair(dst);
      const [sl, sh] = this.pairOf(src);
      this.emit({ op: 'mv', rd: dl, rs1: sl });
      this.emit({ op: 'mv', rd: dh, rs1: sh });
    } else if (isFloatType(dst.type)) this.emit({ op: 'fmv.d', rd: this.vreg(dst), rs1: this.freg(src) });
    else this.emit({ op: 'mv', rd: this.vreg(dst), rs1: this.reg(src) });
  }

  private lowerLoad(dst: Reg, base: MReg, off: number): void {
    switch (dst.type) {
      case 'i1': this.emit({ op: 'lbu', rd: this.vreg(dst), rs1: base, imm: off }); break;
      case 'i8': this.emit({ op: 'lb', rd: this.vreg(dst), rs1: base, imm: off }); break;
      case 'i16': this.emit({ op: 'lh', rd: this.vreg(dst), rs1: base, imm: off }); break;
      case 'i32': case 'ptr': this.emit({ op: 'lw', rd: this.vreg(dst), rs1: base, imm: off }); break;
      case 'i64': {
        const [lo, hi] = this.pair(dst);
        this.emit({ op: 'lw', rd: lo, rs1: base, imm: off });
        this.emit({ op: 'lw', rd: hi, rs1: base, imm: off + 4 });
        break;
      }
      case 'f32': this.emit({ op: 'flw', rd: this.vreg(dst), rs1: base, imm: off }); break;
      case 'f64': this.emit({ op: 'fld', rd: this.vreg(dst), rs1: base, imm: off }); break;
      case 'void': break;
    }
  }

  private lowerStore(val: Value, base: MReg, off: number): void {
    switch (val.type) {
      case 'i1': case 'i8': this.emit({ op: 'sb', rs2: this.reg(val), rs1: base, imm: off }); break;
      case 'i16': this.emit({ op: 'sh', rs2: this.reg(val), rs1: base, imm: off }); break;
      case 'i32': case 'ptr': this.emit({ op: 'sw', rs2: this.reg(val), rs1: base, imm: off }); break;
      case 'i64': {
        const [lo, hi] = this.pairOf(val);
        this.emit({ op: 'sw', rs2: lo, rs1: base, imm: off });
        this.emit({ op: 'sw', rs2: hi, rs1: base, imm: off + 4 });
        break;
      }
      case 'f32': this.emit({ op: 'fsw', rs2: this.freg(val), rs1: base, imm: off }); break;
      case 'f64': this.emit({ op: 'fsd', rs2: this.freg(val), rs1: base, imm: off }); break;
      case 'void': break;
    }
  }

  private lowerBin(i: Extract<Instr, { op: 'bin' }>): void {
    const t = i.dst.type;
    if (isFloatType(t)) {
      const sfx = t === 'f32' ? '.s' : '.d';
      const op = { fadd: 'fadd', fsub: 'fsub', fmul: 'fmul', fdiv: 'fdiv' }[i.opc as 'fadd' | 'fsub' | 'fmul' | 'fdiv'];
      this.emit({ op: op + sfx, rd: this.vreg(i.dst), rs1: this.freg(i.a), rs2: this.freg(i.b) });
      return;
    }
    if (t === 'i64') return this.lowerBin64(i);
    const dst = this.vreg(i.dst);
    const a = this.reg(i.a);
    const immOps: Record<string, string> = { add: 'addi', and: 'andi', or: 'ori', xor: 'xori', shl: 'slli', lshr: 'srli', ashr: 'srai' };
    if (i.b.kind === 'const') {
      const n = Number(BigInt.asIntN(32, i.b.i));
      if (i.opc === 'sub' && this.fits12(-n)) {
        this.emit({ op: 'addi', rd: dst, rs1: a, imm: -n });
        return this.canonicalize(dst, t);
      }
      const io = immOps[i.opc];
      if (io) {
        const isShift = io.startsWith('s');
        const imm = isShift ? n & 31 : n;
        if (isShift || this.fits12(imm)) {
          this.emit({ op: io, rd: dst, rs1: a, imm });
          return this.canonicalize(dst, t);
        }
      }
    }
    const b = this.reg(i.b);
    const rr: Record<string, string> = { add: 'add', sub: 'sub', mul: 'mul', sdiv: 'div', udiv: 'divu', srem: 'rem', urem: 'remu', and: 'and', or: 'or', xor: 'xor', shl: 'sll', lshr: 'srl', ashr: 'sra' };
    const op = rr[i.opc];
    if (!op) throw new Error(`isel: bad binop ${i.opc}`);
    if ((i.opc === 'udiv' || i.opc === 'urem' || i.opc === 'lshr') && t !== 'i32' && t !== 'ptr') {
      // Narrow unsigned ops need zero-extended operands.
      const za = this.tmp();
      const zb = this.tmp();
      this.zext(za, a, t);
      this.zext(zb, b, t);
      this.emit({ op, rd: dst, rs1: za, rs2: zb });
    } else this.emit({ op, rd: dst, rs1: a, rs2: b });
    this.canonicalize(dst, t);
  }

  /** Narrow integer results are kept sign-extended in their 32-bit register. */
  private canonicalize(r: MReg, t: IrType): void {
    if (t === 'i8') {
      this.emit({ op: 'slli', rd: r, rs1: r, imm: 24 });
      this.emit({ op: 'srai', rd: r, rs1: r, imm: 24 });
    } else if (t === 'i16') {
      this.emit({ op: 'slli', rd: r, rs1: r, imm: 16 });
      this.emit({ op: 'srai', rd: r, rs1: r, imm: 16 });
    } else if (t === 'i1') {
      this.emit({ op: 'andi', rd: r, rs1: r, imm: 1 });
    }
  }
  private zext(dst: MReg, src: MReg, t: IrType): void {
    if (t === 'i8') this.emit({ op: 'andi', rd: dst, rs1: src, imm: 255 });
    else if (t === 'i16') {
      this.emit({ op: 'slli', rd: dst, rs1: src, imm: 16 });
      this.emit({ op: 'srli', rd: dst, rs1: dst, imm: 16 });
    } else if (t === 'i1') this.emit({ op: 'andi', rd: dst, rs1: src, imm: 1 });
    else this.emit({ op: 'mv', rd: dst, rs1: src });
  }

  private lowerBin64(i: Extract<Instr, { op: 'bin' }>): void {
    const [dl, dh] = this.pair(i.dst);
    const [al, ah] = this.pairOf(i.a);
    switch (i.opc) {
      case 'add': {
        const [bl, bh] = this.pairOf(i.b);
        const c = this.tmp();
        this.emit({ op: 'add', rd: dl, rs1: al, rs2: bl });
        this.emit({ op: 'sltu', rd: c, rs1: dl, rs2: al, comment: 'carry' });
        this.emit({ op: 'add', rd: dh, rs1: ah, rs2: bh });
        this.emit({ op: 'add', rd: dh, rs1: dh, rs2: c });
        return;
      }
      case 'sub': {
        const [bl, bh] = this.pairOf(i.b);
        const c = this.tmp();
        this.emit({ op: 'sltu', rd: c, rs1: al, rs2: bl, comment: 'borrow' });
        this.emit({ op: 'sub', rd: dl, rs1: al, rs2: bl });
        this.emit({ op: 'sub', rd: dh, rs1: ah, rs2: bh });
        this.emit({ op: 'sub', rd: dh, rs1: dh, rs2: c });
        return;
      }
      case 'and': case 'or': case 'xor': {
        const [bl, bh] = this.pairOf(i.b);
        this.emit({ op: i.opc, rd: dl, rs1: al, rs2: bl });
        this.emit({ op: i.opc, rd: dh, rs1: ah, rs2: bh });
        return;
      }
      default: {
        const helper = I64_HELPERS[i.opc];
        if (!helper) throw new Error(`isel: bad i64 op ${i.opc}`);
        const isShift = i.opc === 'shl' || i.opc === 'lshr' || i.opc === 'ashr';
        const sig: Sig = { ret: 'i64', params: ['i64', isShift ? 'i32' : 'i64'], variadic: false, fixed: 2 };
        const b: Value = isShift && i.b.type === 'i64' ? (i.b.kind === 'reg' ? { kind: 'reg', id: i.b.id, type: 'i32' } : { kind: 'const', type: 'i32', i: i.b.i & 63n, f: 0 }) : i.b;
        this.callNative(helper, sig, [i.a, b], i.dst, isShift && i.b.kind === 'reg' ? { [i.b.id]: this.pair(i.b)[0] } : undefined);
      }
    }
  }

  private lowerCmp(i: Extract<Instr, { op: 'cmp' }>): void {
    const dst = this.vreg(i.dst);
    const t = i.a.type;
    if (isFloatType(t)) {
      const sfx = t === 'f32' ? '.s' : '.d';
      const a = this.freg(i.a);
      const b = this.freg(i.b);
      switch (i.opc) {
        case 'oeq': this.emit({ op: 'feq' + sfx, rd: dst, rs1: a, rs2: b }); break;
        case 'one': this.emit({ op: 'feq' + sfx, rd: dst, rs1: a, rs2: b }); this.emit({ op: 'xori', rd: dst, rs1: dst, imm: 1 }); break;
        case 'olt': this.emit({ op: 'flt' + sfx, rd: dst, rs1: a, rs2: b }); break;
        case 'ole': this.emit({ op: 'fle' + sfx, rd: dst, rs1: a, rs2: b }); break;
        case 'ogt': this.emit({ op: 'flt' + sfx, rd: dst, rs1: b, rs2: a }); break;
        case 'oge': this.emit({ op: 'fle' + sfx, rd: dst, rs1: b, rs2: a }); break;
        default: throw new Error(`isel: bad fcmp ${i.opc}`);
      }
      return;
    }
    if (t === 'i64') return this.lowerCmp64(i);
    const a = this.reg(i.a);
    const b = this.reg(i.b);
    switch (i.opc) {
      case 'eq':
        if (b === 'zero') this.emit({ op: 'seqz', rd: dst, rs1: a });
        else { this.emit({ op: 'xor', rd: dst, rs1: a, rs2: b }); this.emit({ op: 'seqz', rd: dst, rs1: dst }); }
        break;
      case 'ne':
        if (b === 'zero') this.emit({ op: 'snez', rd: dst, rs1: a });
        else { this.emit({ op: 'xor', rd: dst, rs1: a, rs2: b }); this.emit({ op: 'snez', rd: dst, rs1: dst }); }
        break;
      case 'slt': this.emit({ op: 'slt', rd: dst, rs1: a, rs2: b }); break;
      case 'sgt': this.emit({ op: 'slt', rd: dst, rs1: b, rs2: a }); break;
      case 'sle': this.emit({ op: 'slt', rd: dst, rs1: b, rs2: a }); this.emit({ op: 'xori', rd: dst, rs1: dst, imm: 1 }); break;
      case 'sge': this.emit({ op: 'slt', rd: dst, rs1: a, rs2: b }); this.emit({ op: 'xori', rd: dst, rs1: dst, imm: 1 }); break;
      case 'ult': this.emit({ op: 'sltu', rd: dst, rs1: a, rs2: b }); break;
      case 'ugt': this.emit({ op: 'sltu', rd: dst, rs1: b, rs2: a }); break;
      case 'ule': this.emit({ op: 'sltu', rd: dst, rs1: b, rs2: a }); this.emit({ op: 'xori', rd: dst, rs1: dst, imm: 1 }); break;
      case 'uge': this.emit({ op: 'sltu', rd: dst, rs1: a, rs2: b }); this.emit({ op: 'xori', rd: dst, rs1: dst, imm: 1 }); break;
      default: throw new Error(`isel: bad cmp ${i.opc}`);
    }
  }

  private lowerCmp64(i: Extract<Instr, { op: 'cmp' }>): void {
    const dst = this.vreg(i.dst);
    const [al, ah] = this.pairOf(i.a);
    const [bl, bh] = this.pairOf(i.b);
    if (i.opc === 'eq' || i.opc === 'ne') {
      const t1 = this.tmp();
      const t2 = this.tmp();
      this.emit({ op: 'xor', rd: t1, rs1: al, rs2: bl });
      this.emit({ op: 'xor', rd: t2, rs1: ah, rs2: bh });
      this.emit({ op: 'or', rd: dst, rs1: t1, rs2: t2 });
      this.emit({ op: i.opc === 'eq' ? 'seqz' : 'snez', rd: dst, rs1: dst });
      return;
    }
    const unsigned = i.opc.startsWith('u');
    const r: Reg = { kind: 'reg', id: -1, type: 'i32' };
    const tmp = this.tmp();
    this.callNativeRaw(unsigned ? '__ucmpdi2' : '__cmpdi2', { ret: 'i32', params: ['i64', 'i64'], variadic: false, fixed: 2 }, [[al, ah], [bl, bh]], tmp, null);
    void r;
    // helper returns 0 (a<b), 1 (a==b), 2 (a>b)
    switch (i.opc) {
      case 'slt': case 'ult': this.emit({ op: 'seqz', rd: dst, rs1: tmp }); break;
      case 'sle': case 'ule': this.emit({ op: 'sltiu', rd: dst, rs1: tmp, imm: 2 }); break;
      case 'sgt': case 'ugt': this.emit({ op: 'sltiu', rd: dst, rs1: tmp, imm: 2 }); this.emit({ op: 'xori', rd: dst, rs1: dst, imm: 1 }); break;
      case 'sge': case 'uge': this.emit({ op: 'snez', rd: dst, rs1: tmp }); break;
    }
  }

  private lowerCast(i: Extract<Instr, { op: 'cast' }>): void {
    const from = i.src.type;
    const to = i.dst.type;
    switch (i.opc) {
      case 'trunc': {
        if (from === 'i64') {
          const [lo] = this.pairOf(i.src);
          const dst = this.vreg(i.dst);
          this.emit({ op: 'mv', rd: dst, rs1: lo });
          this.canonicalize(dst, to);
        } else {
          const dst = this.vreg(i.dst);
          this.emit({ op: 'mv', rd: dst, rs1: this.reg(i.src) });
          this.canonicalize(dst, to);
        }
        return;
      }
      case 'sext': {
        if (to === 'i64') {
          const [lo, hi] = this.pair(i.dst);
          this.emit({ op: 'mv', rd: lo, rs1: this.reg(i.src) });
          this.emit({ op: 'srai', rd: hi, rs1: lo, imm: 31 });
        } else this.emit({ op: 'mv', rd: this.vreg(i.dst), rs1: this.reg(i.src) });
        return;
      }
      case 'zext': {
        if (to === 'i64') {
          const [lo, hi] = this.pair(i.dst);
          this.zext(lo, this.reg(i.src), from);
          this.emit({ op: 'mv', rd: hi, rs1: 'zero' });
        } else this.zext(this.vreg(i.dst), this.reg(i.src), from);
        return;
      }
      case 'ptrtoint': case 'inttoptr': case 'bitcast': {
        if (from === 'i64') this.emit({ op: 'mv', rd: this.vreg(i.dst), rs1: this.pairOf(i.src)[0] });
        else if (to === 'i64') {
          const [lo, hi] = this.pair(i.dst);
          this.emit({ op: 'mv', rd: lo, rs1: this.reg(i.src) });
          this.emit({ op: 'mv', rd: hi, rs1: 'zero' });
        } else this.emit({ op: 'mv', rd: this.vreg(i.dst), rs1: this.reg(i.src) });
        return;
      }
      case 'sitofp': case 'uitofp': {
        const u = i.opc === 'uitofp';
        if (from === 'i64') {
          const helper = to === 'f32' ? (u ? '__floatundisf' : '__floatdisf') : u ? '__floatundidf' : '__floatdidf';
          this.callNative(helper, { ret: to, params: ['i64'], variadic: false, fixed: 1 }, [i.src], i.dst);
          return;
        }
        let src = this.reg(i.src);
        if (u && from !== 'i32' && from !== 'ptr') {
          const z = this.tmp();
          this.zext(z, src, from);
          src = z;
        }
        this.emit({ op: `fcvt.${to === 'f32' ? 's' : 'd'}.${u ? 'wu' : 'w'}`, rd: this.vreg(i.dst), rs1: src });
        return;
      }
      case 'fptosi': case 'fptoui': {
        const u = i.opc === 'fptoui';
        if (to === 'i64') {
          const helper = from === 'f32' ? (u ? '__fixunssfdi' : '__fixsfdi') : u ? '__fixunsdfdi' : '__fixdfdi';
          this.callNative(helper, { ret: 'i64', params: [from], variadic: false, fixed: 1 }, [i.src], i.dst);
          return;
        }
        const dst = this.vreg(i.dst);
        this.emit({ op: `fcvt.${u ? 'wu' : 'w'}.${from === 'f32' ? 's' : 'd'}`, rd: dst, rs1: this.freg(i.src), comment: 'rtz' });
        this.canonicalize(dst, to);
        return;
      }
      case 'fpext': this.emit({ op: 'fcvt.d.s', rd: this.vreg(i.dst), rs1: this.freg(i.src) }); return;
      case 'fptrunc': this.emit({ op: 'fcvt.s.d', rd: this.vreg(i.dst), rs1: this.freg(i.src) }); return;
    }
  }

  // -- calls ----------------------------------------------------------------------------

  private lowerCall(i: Extract<Instr, { op: 'call' }>): void {
    const calleeReg = typeof i.callee === 'string' ? null : this.reg(i.callee);
    this.callNative(typeof i.callee === 'string' ? i.callee : null, i.sig, i.args, i.dst ?? null, undefined, calleeReg);
  }

  /** Emit a full call sequence for `args` (IR values) per the ABI. */
  private callNative(callee: string | null, sig: Sig, args: Value[], dst: Reg | null, overridePairs?: Record<number, MReg>, calleeReg: MReg | null = null): void {
    const regs: (MReg | [MReg, MReg])[] = args.map((a, k) => {
      const t = sig.params[k] ?? a.type;
      const variadicFloat = isFloatType(t) && k >= (sig.fixed ?? sig.params.length);
      if (t === 'i64') {
        if (overridePairs && a.kind === 'reg' && overridePairs[a.id]) return overridePairs[a.id]!;
        return this.pairOf(a);
      }
      if (variadicFloat) {
        // Promoted double travelling in integer registers: spill its bits via memory.
        const f = this.freg(a);
        const lo = this.tmp();
        const hi = this.tmp();
        this.emit({ op: 'addi', rd: 'sp', rs1: 'sp', imm: -16 });
        this.emit({ op: 'fsd', rs2: f, rs1: 'sp', imm: 0, comment: 'double → int pair' });
        this.emit({ op: 'lw', rd: lo, rs1: 'sp', imm: 0 });
        this.emit({ op: 'lw', rd: hi, rs1: 'sp', imm: 4 });
        this.emit({ op: 'addi', rd: 'sp', rs1: 'sp', imm: 16 });
        return [lo, hi];
      }
      if (isFloatType(t)) return this.freg(a);
      return overridePairs && a.kind === 'reg' && overridePairs[a.id] ? overridePairs[a.id]! : this.reg(a);
    });
    this.callNativeRaw(callee, sig, regs, dst, calleeReg);
  }

  private callNativeRaw(callee: string | null, sig: Sig, regs: (MReg | [MReg, MReg])[], dst: Reg | MReg | null, calleeReg: MReg | null): void {
    const seq = ++this.callSeq;
    const params = sig.params.length >= regs.length ? sig.params.slice(0, regs.length) : regs.map((r, k) => sig.params[k] ?? (Array.isArray(r) ? 'i64' : 'i32'));
    const { locs, stackBytes } = assignArgs(params, sig.fixed ?? params.length);
    const mark = (ins: MInstr): MInstr => {
      ins.callSeq = seq;
      return this.emit(ins);
    };
    if (stackBytes > 0) mark({ op: 'addi', rd: 'sp', rs1: 'sp', imm: -stackBytes, comment: 'outgoing stack args' });
    this.m.outgoingArgBytes = Math.max(this.m.outgoingArgBytes, stackBytes);
    // Stack arguments first (they use no argument registers), then register arguments.
    regs.forEach((r, k) => {
      const loc = locs[k]!;
      if (loc.kind !== 'stack') return;
      if (Array.isArray(r)) {
        mark({ op: 'sw', rs2: r[0], rs1: 'sp', imm: loc.offset! });
        mark({ op: 'sw', rs2: r[1], rs1: 'sp', imm: loc.offset! + 4 });
      } else if (r.startsWith('f')) mark({ op: loc.type === 'f32' ? 'fsw' : 'fsd', rs2: r, rs1: 'sp', imm: loc.offset! });
      else mark({ op: 'sw', rs2: r, rs1: 'sp', imm: loc.offset! });
    });
    regs.forEach((r, k) => {
      const loc = locs[k]!;
      switch (loc.kind) {
        case 'ireg': mark({ op: 'mv', rd: loc.reg!, rs1: r as MReg, comment: `arg ${k}` }); break;
        case 'freg': mark({ op: loc.type === 'f32' ? 'fmv.s' : 'fmv.d', rd: loc.reg!, rs1: r as MReg, comment: `arg ${k}` }); break;
        case 'ipair': {
          const [lo, hi] = r as [MReg, MReg];
          mark({ op: 'mv', rd: loc.reg!, rs1: lo, comment: `arg ${k} (lo)` });
          mark({ op: 'mv', rd: loc.hi!, rs1: hi, comment: `arg ${k} (hi)` });
          break;
        }
        default: break;
      }
    });
    if (callee !== null) mark({ op: 'call', target: callee, sig, isCall: true });
    else mark({ op: 'jalr', rs1: calleeReg!, sig, isCall: true });
    if (stackBytes > 0) mark({ op: 'addi', rd: 'sp', rs1: 'sp', imm: stackBytes });
    if (dst) {
      if (typeof dst === 'string') mark({ op: 'mv', rd: dst, rs1: 'a0' });
      else if (dst.type === 'i64') {
        const [lo, hi] = this.pair(dst);
        mark({ op: 'mv', rd: lo, rs1: 'a0' });
        mark({ op: 'mv', rd: hi, rs1: 'a1' });
      } else if (isFloatType(dst.type)) mark({ op: dst.type === 'f32' ? 'fmv.s' : 'fmv.d', rd: this.vreg(dst), rs1: 'fa0' });
      else mark({ op: 'mv', rd: this.vreg(dst), rs1: 'a0' });
    }
  }
}

export { bits };
