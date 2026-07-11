import { Func, Block, Instr, Reg, Value, blockMap, predecessors, successors, terminatorOf, defOf, usesOf } from '../ir';

/**
 * Control-flow analyses shared by the passes: reverse postorder, dominators
 * (Cooper–Harvey–Kennedy), dominance frontiers, the dominator tree, and
 * natural loops found from back edges.
 */

export interface Cfg {
  blocks: Map<string, Block>;
  preds: Map<string, string[]>;
  succs: Map<string, string[]>;
  /** Reverse postorder from the entry (unreachable blocks excluded). */
  rpo: string[];
  /** Immediate dominator of each reachable block (entry maps to itself). */
  idom: Map<string, string>;
  /** Children in the dominator tree. */
  domChildren: Map<string, string[]>;
  /** Dominance frontier. */
  df: Map<string, Set<string>>;
}

export function analyze(f: Func): Cfg {
  const blocks = blockMap(f);
  const preds = predecessors(f);
  const succs = new Map<string, string[]>();
  for (const b of f.blocks) {
    const t = terminatorOf(b);
    succs.set(b.name, t ? successors(t) : []);
  }
  const entry = f.blocks[0]!.name;

  // Postorder DFS from the entry.
  const post: string[] = [];
  const seen = new Set<string>();
  const stack: [string, number][] = [[entry, 0]];
  seen.add(entry);
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    const ss = succs.get(top[0]) ?? [];
    if (top[1] < ss.length) {
      const n = ss[top[1]++]!;
      if (!seen.has(n)) {
        seen.add(n);
        stack.push([n, 0]);
      }
    } else {
      post.push(top[0]);
      stack.pop();
    }
  }
  const rpo = post.slice().reverse();
  const rpoIndex = new Map<string, number>();
  rpo.forEach((b, i) => rpoIndex.set(b, i));

  // Dominators (Cooper, Harvey, Kennedy).
  const idom = new Map<string, string>();
  idom.set(entry, entry);
  const intersect = (a: string, b: string): string => {
    let x = a;
    let y = b;
    while (x !== y) {
      while (rpoIndex.get(x)! > rpoIndex.get(y)!) x = idom.get(x)!;
      while (rpoIndex.get(y)! > rpoIndex.get(x)!) y = idom.get(y)!;
    }
    return x;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of rpo) {
      if (b === entry) continue;
      let newIdom: string | null = null;
      for (const p of preds.get(b) ?? []) {
        if (!idom.has(p)) continue;
        newIdom = newIdom === null ? p : intersect(p, newIdom);
      }
      if (newIdom !== null && idom.get(b) !== newIdom) {
        idom.set(b, newIdom);
        changed = true;
      }
    }
  }
  const domChildren = new Map<string, string[]>();
  for (const b of rpo) domChildren.set(b, []);
  for (const b of rpo) if (b !== entry) domChildren.get(idom.get(b)!)!.push(b);

  // Dominance frontiers.
  const df = new Map<string, Set<string>>();
  for (const b of rpo) df.set(b, new Set());
  for (const b of rpo) {
    const ps = (preds.get(b) ?? []).filter((p) => idom.has(p));
    if (ps.length < 2) continue;
    for (const p of ps) {
      let runner = p;
      while (runner !== idom.get(b)) {
        df.get(runner)!.add(b);
        runner = idom.get(runner)!;
      }
    }
  }
  return { blocks, preds, succs, rpo, idom, domChildren, df };
}

export function dominates(cfg: Cfg, a: string, b: string): boolean {
  let cur = b;
  for (;;) {
    if (cur === a) return true;
    const next = cfg.idom.get(cur);
    if (next === undefined || next === cur) return false;
    cur = next;
  }
}

export interface Loop {
  header: string;
  /** Blocks in the loop, including the header. */
  body: Set<string>;
  /** Predecessors of the header that are inside the loop (latches). */
  latches: string[];
}

/** Natural loops from back edges (an edge n→h where h dominates n). */
export function findLoops(cfg: Cfg): Loop[] {
  const loops = new Map<string, Loop>();
  for (const n of cfg.rpo) {
    for (const h of cfg.succs.get(n) ?? []) {
      if (!cfg.idom.has(h) || !dominates(cfg, h, n)) continue;
      let loop = loops.get(h);
      if (!loop) {
        loop = { header: h, body: new Set([h]), latches: [] };
        loops.set(h, loop);
      }
      loop.latches.push(n);
      // Collect the body: everything that reaches n without passing through h.
      const work = [n];
      while (work.length) {
        const b = work.pop()!;
        if (loop.body.has(b)) continue;
        loop.body.add(b);
        for (const p of cfg.preds.get(b) ?? []) if (!loop.body.has(p)) work.push(p);
      }
    }
  }
  // Inner loops first (smaller bodies) so hoisting cascades outward.
  return [...loops.values()].sort((a, b) => a.body.size - b.body.size);
}

/** Highest register id in a function (+1 is the next free). */
export function maxRegId(f: Func): number {
  let max = -1;
  for (const p of f.params) max = Math.max(max, p.id);
  for (const b of f.blocks) {
    for (const i of b.instrs) {
      const d = defOf(i);
      if (d) max = Math.max(max, d.id);
      for (const u of usesOf(i)) if (u.kind === 'reg') max = Math.max(max, u.id);
    }
  }
  return max;
}

/** Map of register id → number of uses across the function. */
export function useCounts(f: Func): Map<number, number> {
  const counts = new Map<number, number>();
  for (const b of f.blocks) {
    for (const i of b.instrs) {
      for (const u of usesOf(i)) if (u.kind === 'reg') counts.set(u.id, (counts.get(u.id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Map of register id → its defining instruction (and block). */
export function definitions(f: Func): Map<number, { instr: Instr; block: Block }> {
  const defs = new Map<number, { instr: Instr; block: Block }>();
  for (const b of f.blocks) for (const i of b.instrs) {
    const d = defOf(i);
    if (d) defs.set(d.id, { instr: i, block: b });
  }
  return defs;
}

/** Replace every use of register `from` with `to`, function-wide. */
export function replaceAllUses(f: Func, from: Reg, to: Value): void {
  const sub = (v: Value): Value => (v.kind === 'reg' && v.id === from.id ? to : v);
  for (const b of f.blocks) for (const i of b.instrs) mapUsesInPlace(i, sub);
}

import { mapUses } from '../ir';
function mapUsesInPlace(i: Instr, f: (v: Value) => Value): void {
  mapUses(i, f);
}

/** Rename phi incoming-block references from `oldName` to `newName` in block `b`. */
export function renamePhiPred(b: Block, oldName: string, newName: string): void {
  for (const i of b.instrs) {
    if (i.op !== 'phi') break;
    for (const inc of i.incoming) if (inc.block === oldName) inc.block = newName;
  }
}
