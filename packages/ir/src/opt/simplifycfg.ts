import { Func, Instr, successors, terminatorOf, predecessors, blockMap } from '../ir';
import { renamePhiPred } from './analysis';

/**
 * CFG cleanup: fold constant branches, delete unreachable blocks, thread
 * jumps through empty forwarding blocks, and merge straight-line block
 * chains. Runs between most other passes because they leave debris behind.
 */
export function simplifyCfg(f: Func): number {
  let changes = 0;
  for (let iter = 0; iter < 20; iter++) {
    let n = 0;
    n += foldConstantBranches(f);
    n += removeUnreachable(f);
    n += threadEmptyBlocks(f);
    n += mergeChains(f);
    n += pruneSinglePhis(f);
    changes += n;
    if (n === 0) break;
  }
  return changes;
}

function foldConstantBranches(f: Func): number {
  let n = 0;
  for (const b of f.blocks) {
    const t = terminatorOf(b);
    if (!t) continue;
    if (t.op === 'condbr') {
      if (t.cond.kind === 'const') {
        const target = t.cond.i !== 0n ? t.then : t.else;
        const dropped = t.cond.i !== 0n ? t.else : t.then;
        b.instrs[b.instrs.length - 1] = { op: 'br', target, line: t.line };
        if (dropped !== target) removePhiEntries(f, dropped, b.name);
        n++;
      } else if (t.then === t.else) {
        b.instrs[b.instrs.length - 1] = { op: 'br', target: t.then, line: t.line };
        n++;
      }
    } else if (t.op === 'switch' && t.val.kind === 'const') {
      const v = t.val.i;
      const hit = t.cases.find((c) => c.value === v);
      const target = hit ? hit.target : t.default;
      const all = new Set(successors(t));
      all.delete(target);
      for (const d of all) removePhiEntries(f, d, b.name);
      b.instrs[b.instrs.length - 1] = { op: 'br', target, line: t.line };
      n++;
    }
  }
  return n;
}

function removePhiEntries(f: Func, blockName: string, pred: string): void {
  const b = f.blocks.find((x) => x.name === blockName);
  if (!b) return;
  for (const i of b.instrs) {
    if (i.op !== 'phi') break;
    i.incoming = i.incoming.filter((x) => x.block !== pred);
  }
}

export function removeUnreachable(f: Func): number {
  const blocks = blockMap(f);
  const reachable = new Set<string>();
  const work = [f.blocks[0]!.name];
  while (work.length) {
    const name = work.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const b = blocks.get(name);
    const t = b && terminatorOf(b);
    if (t) for (const s of successors(t)) work.push(s);
  }
  const before = f.blocks.length;
  const dead = f.blocks.filter((b) => !reachable.has(b.name)).map((b) => b.name);
  if (dead.length === 0) return 0;
  f.blocks = f.blocks.filter((b) => reachable.has(b.name));
  // Drop phi entries that came from deleted blocks.
  for (const b of f.blocks) {
    for (const i of b.instrs) {
      if (i.op !== 'phi') break;
      i.incoming = i.incoming.filter((x) => reachable.has(x.block));
    }
  }
  return before - f.blocks.length;
}

/** A block that only does `br X` can be bypassed by its predecessors. */
function threadEmptyBlocks(f: Func): number {
  let n = 0;
  for (const b of f.blocks) {
    if (b === f.blocks[0]) continue;
    if (b.instrs.length !== 1 || b.instrs[0]!.op !== 'br') continue;
    const target = (b.instrs[0] as Extract<Instr, { op: 'br' }>).target;
    if (target === b.name) continue;
    const tb = f.blocks.find((x) => x.name === target)!;
    const hasPhis = tb.instrs.some((i) => i.op === 'phi');
    const preds = predecessors(f); // fresh: earlier threading changed edges
    const targetPreds = new Set(preds.get(target) ?? []);
    for (const p of preds.get(b.name) ?? []) {
      const pb = f.blocks.find((x) => x.name === p)!;
      const t = terminatorOf(pb)!;
      // With phis in the target, an edge p→target may exist only once, and a
      // terminator with several edges into `b` would need several distinct
      // phi entries — leave those alone.
      if (hasPhis) {
        if (targetPreds.has(p)) continue;
        const edgesIntoB = successorsWithRepeats(t).filter((s) => s === b.name).length;
        if (edgesIntoB > 1) continue;
      }
      retarget(t, b.name, target);
      targetPreds.add(p);
      if (hasPhis) {
        for (const i of tb.instrs) {
          if (i.op !== 'phi') break;
          const inc = i.incoming.find((x) => x.block === b.name);
          if (inc) i.incoming.push({ value: inc.value, block: p });
        }
      }
      n++;
    }
    // Phi entries from `b` itself go away once no one jumps through it.
    const stillUsed = f.blocks.some((x) => {
      const t = terminatorOf(x);
      return t && successors(t).includes(b.name);
    });
    if (!stillUsed) {
      for (const i of tb.instrs) {
        if (i.op !== 'phi') break;
        i.incoming = i.incoming.filter((x) => x.block !== b.name);
      }
    }
  }
  return n;
}

function successorsWithRepeats(t: Instr): string[] {
  switch (t.op) {
    case 'br': return [t.target];
    case 'condbr': return [t.then, t.else];
    case 'switch': return [t.default, ...t.cases.map((c) => c.target)];
    default: return [];
  }
}

function retarget(t: Instr, from: string, to: string): void {
  switch (t.op) {
    case 'br': if (t.target === from) t.target = to; break;
    case 'condbr':
      if (t.then === from) t.then = to;
      if (t.else === from) t.else = to;
      break;
    case 'switch':
      if (t.default === from) t.default = to;
      for (const c of t.cases) if (c.target === from) c.target = to;
      break;
    default: break;
  }
}

/** Merge `b` into its unique predecessor when that predecessor only jumps to `b`. */
function mergeChains(f: Func): number {
  let n = 0;
  for (;;) {
    const preds = predecessors(f);
    let merged = false;
    for (const b of f.blocks) {
      if (b === f.blocks[0]) continue;
      const ps = preds.get(b.name) ?? [];
      if (ps.length !== 1) continue;
      const p = f.blocks.find((x) => x.name === ps[0])!;
      const t = terminatorOf(p);
      if (!t || t.op !== 'br' || t.target !== b.name) continue;
      if (b.instrs.some((i) => i.op === 'phi')) {
        // A phi with a single predecessor is just its one value.
        for (const i of b.instrs) {
          if (i.op !== 'phi') break;
          const inc = i.incoming[0];
          if (!inc) continue;
          replaceUsesIn(f, i.dst.id, inc.value);
        }
        b.instrs = b.instrs.filter((i) => i.op !== 'phi');
      }
      p.instrs.pop();
      p.instrs.push(...b.instrs);
      const bt = terminatorOf(b);
      if (bt) for (const s of successors(bt)) {
        const sb = f.blocks.find((x) => x.name === s);
        if (sb) renamePhiPred(sb, b.name, p.name);
      }
      f.blocks = f.blocks.filter((x) => x !== b);
      merged = true;
      n++;
      break;
    }
    if (!merged) return n;
  }
}

function pruneSinglePhis(f: Func): number {
  let n = 0;
  for (const b of f.blocks) {
    for (const i of b.instrs.slice()) {
      if (i.op !== 'phi') break;
      const distinct = new Map<string, Instr['op'] extends never ? never : import('../ir').Value>();
      for (const inc of i.incoming) {
        const key = inc.value.kind === 'reg' ? `r${inc.value.id}` : `c${inc.value.i}/${inc.value.f}`;
        if (inc.value.kind === 'reg' && inc.value.id === i.dst.id) continue; // self-reference
        distinct.set(key, inc.value);
      }
      if (distinct.size === 1) {
        replaceUsesIn(f, i.dst.id, [...distinct.values()][0]!);
        b.instrs = b.instrs.filter((x) => x !== i);
        n++;
      }
    }
  }
  return n;
}

import { Value, mapUses } from '../ir';
function replaceUsesIn(f: Func, id: number, to: Value): void {
  for (const b of f.blocks) for (const i of b.instrs) mapUses(i, (v) => (v.kind === 'reg' && v.id === id ? to : v));
}
