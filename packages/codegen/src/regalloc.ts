import {
  MFunc, MBlock, MInstr, MReg, isVirtual, isFloatReg, isLoad, isStore, isBranch, readsOf, writeOf,
  CALLER_SAVED_INT, CALLEE_SAVED_INT, CALLER_SAVED_FLOAT, CALLEE_SAVED_FLOAT, ARG_REGS, FARG_REGS, SCRATCH_INT, SCRATCH_FLOAT,
} from './mir';

/**
 * Register allocation and frame layout.
 *
 * Two allocators are offered so students can compare them:
 *  - naive: every virtual register lives in a stack slot and is loaded into a
 *    scratch register right before each use (what a compiler does at -O0);
 *  - linear scan: compute each virtual register's live interval, sweep the
 *    intervals in start order handing out physical registers, and spill the
 *    interval that ends furthest away when none is free.
 *
 * Afterwards the frame is laid out (return address, saved frame pointer,
 * callee-saved registers, spill slots, local variables) and the prologue
 * and epilogue are inserted.
 */
export type AllocStrategy = 'naive' | 'linear-scan';

export interface IntervalInfo {
  vreg: MReg;
  start: number;
  end: number;
  /** Physical register, or 'stack' when spilled. */
  assigned: string;
  crossesCall: boolean;
}

export interface AllocReport {
  strategy: AllocStrategy;
  intervals: IntervalInfo[];
  spilled: number;
  frameSize: number;
  calleeSaved: string[];
  /** Instruction index → text, for the UI's interval chart. */
  numbering: { index: number; block: string; text: string }[];
}

interface Liveness {
  order: { block: MBlock; start: number; end: number }[];
  liveIn: Map<string, Set<MReg>>;
  liveOut: Map<string, Set<MReg>>;
}

export function allocate(f: MFunc, strategy: AllocStrategy): AllocReport {
  const live = liveness(f);
  const intervals = buildIntervals(f, live);
  const assignment = new Map<MReg, string>(); // vreg → phys | 'stack'
  const calleeUsed = new Set<string>();

  if (strategy === 'naive') {
    for (const v of f.vregs.keys()) assignment.set(v, 'stack');
    for (const iv of intervals) iv.assigned = 'stack';
  } else {
    linearScan(f, intervals, assignment, calleeUsed);
  }
  const spillSlots = new Map<MReg, number>();
  const frame = layoutFrame(f, assignment, calleeUsed, spillSlots);
  rewrite(f, assignment, spillSlots, frame, [...calleeUsed]);
  return {
    strategy,
    intervals,
    spilled: [...assignment.values()].filter((a) => a === 'stack').length,
    frameSize: frame.size,
    calleeSaved: [...calleeUsed],
    numbering: live.order.flatMap(({ block, start }) => block.instrs.map((i, k) => ({ index: start + k, block: block.name, text: fmt(i) }))),
  };
}

import { fmtMInstr } from './mir';
function fmt(i: MInstr): string {
  return fmtMInstr({ ...i, comment: undefined });
}

// -- liveness ----------------------------------------------------------------------

function liveness(f: MFunc): Liveness {
  const order: Liveness['order'] = [];
  let n = 0;
  for (const b of f.blocks) {
    order.push({ block: b, start: n, end: n + b.instrs.length - 1 });
    n += b.instrs.length;
  }
  const succs = new Map<string, string[]>();
  for (const b of f.blocks) {
    const s: string[] = [];
    for (const i of b.instrs) if (isBranch(i.op) && i.target && !s.includes(i.target)) s.push(i.target);
    succs.set(b.name, s);
  }
  const use = new Map<string, Set<MReg>>();
  const def = new Map<string, Set<MReg>>();
  for (const b of f.blocks) {
    const u = new Set<MReg>();
    const d = new Set<MReg>();
    for (const i of b.instrs) {
      for (const r of readsOf(i)) if (isVirtual(r) && !d.has(r)) u.add(r);
      const w = writeOf(i);
      if (isVirtual(w)) d.add(w);
    }
    use.set(b.name, u);
    def.set(b.name, d);
  }
  const liveIn = new Map<string, Set<MReg>>();
  const liveOut = new Map<string, Set<MReg>>();
  for (const b of f.blocks) {
    liveIn.set(b.name, new Set());
    liveOut.set(b.name, new Set());
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = f.blocks.length - 1; k >= 0; k--) {
      const b = f.blocks[k]!;
      const out = new Set<MReg>();
      for (const s of succs.get(b.name) ?? []) for (const v of liveIn.get(s) ?? []) out.add(v);
      const inn = new Set<MReg>(use.get(b.name));
      for (const v of out) if (!def.get(b.name)!.has(v)) inn.add(v);
      if (out.size !== liveOut.get(b.name)!.size || inn.size !== liveIn.get(b.name)!.size) changed = true;
      liveOut.set(b.name, out);
      liveIn.set(b.name, inn);
    }
  }
  return { order, liveIn, liveOut };
}

function buildIntervals(f: MFunc, live: Liveness): IntervalInfo[] {
  const start = new Map<MReg, number>();
  const end = new Map<MReg, number>();
  const touch = (v: MReg, at: number) => {
    start.set(v, Math.min(start.get(v) ?? at, at));
    end.set(v, Math.max(end.get(v) ?? at, at));
  };
  const callIdx: number[] = [];
  for (const { block, start: s, end: e } of live.order) {
    block.instrs.forEach((i, k) => {
      const at = s + k;
      for (const r of readsOf(i)) if (isVirtual(r)) touch(r, at);
      const w = writeOf(i);
      if (isVirtual(w)) touch(w, at);
      if (i.isCall) callIdx.push(at);
    });
    for (const v of live.liveIn.get(block.name) ?? []) touch(v, s);
    for (const v of live.liveOut.get(block.name) ?? []) touch(v, e);
  }
  const out: IntervalInfo[] = [];
  for (const v of f.vregs.keys()) {
    const s = start.get(v);
    const e = end.get(v);
    if (s === undefined || e === undefined) continue;
    out.push({ vreg: v, start: s, end: e, assigned: '', crossesCall: callIdx.some((c) => s < c && c < e) });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

// -- linear scan ------------------------------------------------------------------

function linearScan(f: MFunc, intervals: IntervalInfo[], assignment: Map<MReg, string>, calleeUsed: Set<string>): void {
  // Call-sequence ranges: a value live anywhere inside one must avoid argument registers.
  const seqRange = new Map<number, [number, number]>();
  let idx = 0;
  for (const b of f.blocks) for (const i of b.instrs) {
    if (i.callSeq !== undefined) {
      const r = seqRange.get(i.callSeq) ?? [idx, idx];
      r[0] = Math.min(r[0], idx);
      r[1] = Math.max(r[1], idx);
      seqRange.set(i.callSeq, r);
    }
    idx++;
  }
  const overlapsSeq = (iv: IntervalInfo): boolean => [...seqRange.values()].some(([s, e]) => iv.start <= e && iv.end >= s);

  const free = new Set<string>([...CALLER_SAVED_INT, ...CALLEE_SAVED_INT, ...CALLER_SAVED_FLOAT, ...CALLEE_SAVED_FLOAT]);
  const poolOf = (iv: IntervalInfo): string[] => {
    const fl = f.vregs.get(iv.vreg) === 'float';
    const callee = fl ? CALLEE_SAVED_FLOAT : CALLEE_SAVED_INT;
    const caller = fl ? CALLER_SAVED_FLOAT : CALLER_SAVED_INT;
    const args = fl ? FARG_REGS : ARG_REGS;
    if (iv.crossesCall) return callee;
    const temps = caller.filter((r) => !args.includes(r));
    if (overlapsSeq(iv)) return [...temps, ...callee];
    return [...temps, ...args, ...callee];
  };
  const active: IntervalInfo[] = [];
  for (const iv of intervals) {
    // Expire.
    for (let k = active.length - 1; k >= 0; k--) {
      const a = active[k]!;
      if (a.end < iv.start) {
        free.add(a.assigned);
        active.splice(k, 1);
      }
    }
    const pool = poolOf(iv);
    const reg = pool.find((r) => free.has(r));
    if (reg) {
      free.delete(reg);
      iv.assigned = reg;
      active.push(iv);
      continue;
    }
    // Spill: the active interval (in a register this one could use) that ends last.
    let victim: IntervalInfo | null = null;
    for (const a of active) if (pool.includes(a.assigned) && (!victim || a.end > victim.end)) victim = a;
    if (victim && victim.end > iv.end) {
      iv.assigned = victim.assigned;
      victim.assigned = 'stack';
      active.splice(active.indexOf(victim), 1);
      active.push(iv);
    } else {
      iv.assigned = 'stack';
    }
  }
  for (const iv of intervals) {
    assignment.set(iv.vreg, iv.assigned);
    if (CALLEE_SAVED_INT.includes(iv.assigned) || CALLEE_SAVED_FLOAT.includes(iv.assigned)) calleeUsed.add(iv.assigned);
  }
  for (const v of f.vregs.keys()) if (!assignment.has(v)) assignment.set(v, 'stack');
}

// -- frame ------------------------------------------------------------------------

interface Frame {
  size: number;
  /** fp-relative (negative) offsets. */
  savedRegs: Map<string, number>;
  allocaOffsets: Map<string, number>;
}

function layoutFrame(f: MFunc, assignment: Map<MReg, string>, calleeUsed: Set<string>, spillSlots: Map<MReg, number>): Frame {
  let off = 8; // ra at -4, s0 at -8
  const savedRegs = new Map<string, number>();
  for (const r of [...calleeUsed].sort()) {
    const sz = isFloatReg(r) ? 8 : 4;
    off = align(off + sz, sz);
    savedRegs.set(r, -off);
  }
  for (const [v, a] of assignment) {
    if (a !== 'stack') continue;
    const sz = f.vregs.get(v) === 'float' ? 8 : 4;
    off = align(off + sz, sz);
    spillSlots.set(v, -off);
  }
  const allocaOffsets = new Map<string, number>();
  for (const a of f.allocas) {
    const al = Math.max(4, a.align);
    off = align(off + Math.max(1, a.size), al);
    allocaOffsets.set(a.name, -off);
  }
  return { size: align(off, 16), savedRegs, allocaOffsets };
}

function align(n: number, to: number): number {
  return Math.ceil(n / to) * to;
}
function fits12(n: number): boolean {
  return n >= -2048 && n <= 2047;
}

// -- rewriting ----------------------------------------------------------------------

function rewrite(f: MFunc, assignment: Map<MReg, string>, spillSlots: Map<MReg, number>, frame: Frame, calleeUsed: string[]): void {
  for (const b of f.blocks) {
    const out: MInstr[] = [];
    for (const i of b.instrs) {
      // Frame references.
      if (i.frameSlot !== undefined) {
        const off = frame.allocaOffsets.get(i.frameSlot)!;
        i.frameSlot = undefined;
        i.imm = off;
      }
      if (i.stackParam !== undefined) {
        i.imm = i.stackParam;
        i.stackParam = undefined;
      }
      if (i.op === 'ret') {
        out.push(...epilogue(frame, calleeUsed, i.line));
        continue;
      }
      const before: MInstr[] = [];
      const after: MInstr[] = [];
      const scratch = { int: [...SCRATCH_INT], float: [...SCRATCH_FLOAT] };
      const take = (cls: 'int' | 'float'): string => scratch[cls].shift()!;
      const sub = (r: MReg | undefined, isDef: boolean): MReg | undefined => {
        if (!isVirtual(r)) return r;
        const a = assignment.get(r)!;
        if (a !== 'stack') return a;
        const cls = f.vregs.get(r)!;
        const slot = spillSlots.get(r)!;
        if (isDef) {
          const s = scratch[cls][0] ?? (cls === 'int' ? 't5' : 'ft10');
          after.push(...storeSlot(s, slot, cls));
          return s;
        }
        const s = take(cls);
        before.push(...loadSlot(s, slot, cls));
        return s;
      };
      if (isStore(i.op)) {
        i.rs2 = sub(i.rs2, false);
        i.rs1 = sub(i.rs1, false);
      } else {
        i.rs1 = sub(i.rs1, false);
        i.rs2 = sub(i.rs2, false);
        const w = writeOf(i);
        if (w !== undefined) {
          // Reuse a scratch for the def (reads are done once the instruction executes).
          scratch.int = [...SCRATCH_INT];
          scratch.float = [...SCRATCH_FLOAT];
          i.rd = sub(i.rd, true);
        }
      }
      // Big immediates on frame-relative addressing.
      if ((isLoad(i.op) || isStore(i.op)) && i.imm !== undefined && !fits12(i.imm) && i.rs1 === 's0') {
        const t = isStore(i.op) ? 't6' : (i.rd && !isFloatReg(i.rd) ? i.rd : 't6');
        before.push({ op: 'li', rd: t, imm: i.imm, line: i.line }, { op: 'add', rd: t, rs1: t, rs2: 's0', line: i.line });
        i.rs1 = t;
        i.imm = 0;
      }
      if (i.op === 'addi' && i.imm !== undefined && !fits12(i.imm)) {
        before.push({ op: 'li', rd: i.rd!, imm: i.imm, line: i.line });
        i.op = 'add';
        i.rs2 = i.rs1;
        i.rs1 = i.rd;
        i.imm = undefined;
      }
      if ((i.op === 'mv' || i.op === 'fmv.d' || i.op === 'fmv.s') && i.rd === i.rs1) {
        out.push(...before, ...after);
        continue;
      }
      out.push(...before, i, ...after);
    }
    b.instrs = out;
  }
  f.blocks[0]!.instrs.unshift(...prologue(frame, calleeUsed, f.line));
}

function loadSlot(reg: string, off: number, cls: 'int' | 'float'): MInstr[] {
  const op = cls === 'float' ? 'fld' : 'lw';
  if (fits12(off)) return [{ op, rd: reg, rs1: 's0', imm: off, comment: 'reload' }];
  const t = cls === 'float' ? 't6' : reg;
  return [{ op: 'li', rd: t, imm: off }, { op: 'add', rd: t, rs1: t, rs2: 's0' }, { op, rd: reg, rs1: t, imm: 0, comment: 'reload' }];
}
function storeSlot(reg: string, off: number, cls: 'int' | 'float'): MInstr[] {
  const op = cls === 'float' ? 'fsd' : 'sw';
  if (fits12(off)) return [{ op, rs2: reg, rs1: 's0', imm: off, comment: 'spill' }];
  return [{ op: 'li', rd: 't6', imm: off }, { op: 'add', rd: 't6', rs1: 't6', rs2: 's0' }, { op, rs2: reg, rs1: 't6', imm: 0, comment: 'spill' }];
}

function prologue(frame: Frame, calleeUsed: string[], line?: number): MInstr[] {
  const F = frame.size;
  const out: MInstr[] = [];
  if (fits12(-F)) out.push({ op: 'addi', rd: 'sp', rs1: 'sp', imm: -F, comment: 'prologue: allocate frame', line });
  else out.push({ op: 'li', rd: 't0', imm: F, line }, { op: 'sub', rd: 'sp', rs1: 'sp', rs2: 't0', comment: 'prologue: allocate frame', line });
  // ra and s0 live at the top of the frame: sp+F-4 and sp+F-8.
  if (fits12(F - 4)) {
    out.push({ op: 'sw', rs2: 'ra', rs1: 'sp', imm: F - 4, comment: 'save return address', line });
    out.push({ op: 'sw', rs2: 's0', rs1: 'sp', imm: F - 8, comment: 'save caller frame pointer', line });
    out.push({ op: 'addi', rd: 's0', rs1: 'sp', imm: F, comment: 'fp = old sp', line });
  } else {
    out.push({ op: 'li', rd: 't0', imm: F, line }, { op: 'add', rd: 't0', rs1: 'sp', rs2: 't0', line });
    out.push({ op: 'sw', rs2: 'ra', rs1: 't0', imm: -4, comment: 'save return address', line });
    out.push({ op: 'sw', rs2: 's0', rs1: 't0', imm: -8, comment: 'save caller frame pointer', line });
    out.push({ op: 'mv', rd: 's0', rs1: 't0', comment: 'fp = old sp', line });
  }
  for (const r of calleeUsed) {
    const off = frame.savedRegs.get(r)!;
    out.push(...storeSlot(r, off, isFloatReg(r) ? 'float' : 'int').map((i) => ({ ...i, comment: `save callee-saved ${r}`, line })));
  }
  return out;
}

function epilogue(frame: Frame, calleeUsed: string[], line?: number): MInstr[] {
  const out: MInstr[] = [];
  for (const r of calleeUsed) {
    const off = frame.savedRegs.get(r)!;
    out.push(...loadSlot(r, off, isFloatReg(r) ? 'float' : 'int').map((i) => ({ ...i, comment: `restore ${r}`, line })));
  }
  out.push({ op: 'lw', rd: 'ra', rs1: 's0', imm: -4, comment: 'epilogue: restore return address', line });
  out.push({ op: 'mv', rd: 'sp', rs1: 's0', comment: 'free frame (also undoes any VLA)', line });
  out.push({ op: 'lw', rd: 's0', rs1: 'sp', imm: -8, comment: 'restore caller frame pointer', line });
  out.push({ op: 'ret', line });
  return out;
}
