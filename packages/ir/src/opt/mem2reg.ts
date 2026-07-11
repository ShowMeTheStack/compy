import { Func, Instr, Reg, Value, IrType, Const, constInt, constFloat, isFloatType, usesOf, mapUses } from '../ir';
import { analyze, Cfg, maxRegId } from './analysis';

/**
 * mem2reg — promote stack slots to SSA registers. A local whose address is
 * only ever used by plain loads and stores does not need memory at all: its
 * loads become uses of whichever value was most recently stored, and where
 * control flow merges, a phi node picks between them. This is the classic
 * SSA construction (Cytron et al.): place phis at the iterated dominance
 * frontier of the stores, then rename along the dominator tree.
 */
export function mem2reg(f: Func): number {
  const cfg = analyze(f);
  const candidates = findPromotable(f);
  if (candidates.size === 0) return 0;
  let nextId = maxRegId(f) + 1;

  // Phi placement.
  const phiFor = new Map<string, Map<number, Extract<Instr, { op: 'phi' }>>>(); // block → alloca id → phi
  for (const [allocaId, info] of candidates) {
    const work = [...info.defBlocks];
    const placed = new Set<string>();
    while (work.length) {
      const b = work.pop()!;
      for (const d of cfg.df.get(b) ?? []) {
        if (placed.has(d)) continue;
        placed.add(d);
        const phi: Extract<Instr, { op: 'phi' }> = {
          op: 'phi',
          dst: { kind: 'reg', id: nextId++, type: info.type, name: info.name },
          incoming: [],
        };
        let m = phiFor.get(d);
        if (!m) phiFor.set(d, (m = new Map()));
        m.set(allocaId, phi);
        if (!info.defBlocks.has(d)) work.push(d);
      }
    }
  }
  for (const [blockName, m] of phiFor) {
    const b = cfg.blocks.get(blockName)!;
    b.instrs.unshift(...m.values());
  }

  // Renaming along the dominator tree.
  const stacks = new Map<number, Value[]>();
  for (const [id, info] of candidates) stacks.set(id, [undefValue(info.type)]);
  const rename = (blockName: string): void => {
    const b = cfg.blocks.get(blockName)!;
    const pushed: number[] = [];
    const kept: Instr[] = [];
    for (const i of b.instrs) {
      if (i.op === 'phi') {
        const owner = [...(phiFor.get(blockName)?.entries() ?? [])].find(([, p]) => p === i);
        if (owner) {
          stacks.get(owner[0])!.push(i.dst);
          pushed.push(owner[0]);
        }
        kept.push(i);
        continue;
      }
      if (i.op === 'load' && i.addr.kind === 'reg' && candidates.has(i.addr.id)) {
        const stack = stacks.get(i.addr.id)!;
        const cur = stack[stack.length - 1]!;
        replaceUses(f, i.dst.id, cur, cfg);
        continue; // drop the load
      }
      if (i.op === 'store' && i.addr.kind === 'reg' && candidates.has(i.addr.id)) {
        const stack = stacks.get(i.addr.id)!;
        stack.push(i.val);
        pushed.push(i.addr.id);
        continue; // drop the store
      }
      if (i.op === 'alloca' && candidates.has(i.dst.id)) continue; // drop the slot
      kept.push(i);
    }
    b.instrs = kept;
    // Fill successor phis.
    for (const s of cfg.succs.get(blockName) ?? []) {
      const m = phiFor.get(s);
      if (!m) continue;
      for (const [allocaId, phi] of m) {
        const stack = stacks.get(allocaId)!;
        phi.incoming.push({ value: stack[stack.length - 1]!, block: blockName });
      }
    }
    for (const c of cfg.domChildren.get(blockName) ?? []) rename(c);
    for (const id of pushed) stacks.get(id)!.pop();
  };
  rename(f.blocks[0]!.name);
  // Loads were replaced lazily with the right values; now substitute.
  applyPending(f);
  return candidates.size;
}

interface Promotable {
  type: IrType;
  name: string;
  defBlocks: Set<string>;
}

function findPromotable(f: Func): Map<number, Promotable> {
  const info = new Map<number, Promotable>();
  const bad = new Set<number>();
  const allocas = new Map<number, Extract<Instr, { op: 'alloca' }>>();
  for (const b of f.blocks) for (const i of b.instrs) if (i.op === 'alloca' && i.size.kind === 'const') allocas.set(i.dst.id, i);
  for (const b of f.blocks) {
    for (const i of b.instrs) {
      if (i.op === 'load' && i.addr.kind === 'reg' && allocas.has(i.addr.id)) {
        const a = allocas.get(i.addr.id)!;
        const cur = info.get(a.dst.id);
        if (cur && cur.type !== i.dst.type) bad.add(a.dst.id);
        else if (!cur) info.set(a.dst.id, { type: i.dst.type, name: a.name, defBlocks: new Set() });
        continue;
      }
      if (i.op === 'store' && i.addr.kind === 'reg' && allocas.has(i.addr.id) && !(i.val.kind === 'reg' && allocas.has(i.val.id))) {
        const a = allocas.get(i.addr.id)!;
        const cur = info.get(a.dst.id);
        if (cur && cur.type !== i.val.type) bad.add(a.dst.id);
        else if (!cur) info.set(a.dst.id, { type: i.val.type, name: a.name, defBlocks: new Set([b.name]) });
        else cur.defBlocks.add(b.name);
        continue;
      }
      // Any other use of the address (ptradd, memcpy, call arg, store as value…) escapes it.
      for (const u of usesOf(i)) if (u.kind === 'reg' && allocas.has(u.id)) bad.add(u.id);
    }
  }
  for (const [id, a] of allocas) {
    const p = info.get(id);
    if (!p) {
      // Never loaded or stored: a dead slot — promotable (it simply vanishes).
      if (!bad.has(id)) info.set(id, { type: 'i32', name: a.name, defBlocks: new Set() });
      continue;
    }
    if (Number(a.size.kind === 'const' ? a.size.i : 0n) !== bytesOfType(p.type)) bad.add(id);
  }
  for (const id of bad) info.delete(id);
  return info;
}

function bytesOfType(t: IrType): number {
  switch (t) {
    case 'i1': case 'i8': return 1;
    case 'i16': return 2;
    case 'i64': case 'f64': return 8;
    default: return 4;
  }
}

function undefValue(t: IrType): Const {
  return isFloatType(t) ? constFloat(t, 0) : constInt(t, 0);
}

// Loads are replaced lazily: record substitutions, apply after renaming so
// a value defined later in the walk is not applied prematurely.
const pending = new Map<Func, Map<number, Value>>();
function replaceUses(f: Func, id: number, to: Value, _cfg: Cfg): void {
  let m = pending.get(f);
  if (!m) pending.set(f, (m = new Map()));
  m.set(id, to);
}
function applyPending(f: Func): void {
  const m = pending.get(f);
  if (!m) return;
  pending.delete(f);
  const resolve = (v: Value): Value => {
    let cur = v;
    for (let k = 0; k < 64 && cur.kind === 'reg' && m.has(cur.id); k++) cur = m.get(cur.id)!;
    return cur;
  };
  for (const b of f.blocks) for (const i of b.instrs) mapUses(i, resolve);
}

export type { Reg };
