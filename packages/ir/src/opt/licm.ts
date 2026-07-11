import { Func, Instr, Block, Value, isPure, defOf, usesOf, terminatorOf, successors } from '../ir';
import { analyze, findLoops, renamePhiPred } from './analysis';

/**
 * Loop-invariant code motion: a pure instruction inside a loop whose operands
 * do not change across iterations computes the same thing every time, so it
 * is hoisted into a preheader block that runs once before the loop.
 */
export function loopInvariantCodeMotion(f: Func): number {
  let hoisted = 0;
  const cfg = analyze(f);
  const loops = findLoops(cfg);
  for (const loop of loops) {
    // Where is each register defined?
    const definedIn = new Map<number, string>();
    for (const b of f.blocks) for (const i of b.instrs) {
      const d = defOf(i);
      if (d) definedIn.set(d.id, b.name);
    }
    const invariant = new Set<number>();
    const isInvariantValue = (v: Value): boolean => v.kind === 'const' || invariant.has(v.id) || !loop.body.has(definedIn.get(v.id) ?? '');
    const toHoist: Instr[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const name of loop.body) {
        const b = cfg.blocks.get(name)!;
        for (const i of b.instrs) {
          const d = defOf(i);
          if (!d || invariant.has(d.id) || !isPure(i) || i.op === 'phi') continue;
          if (usesOf(i).every(isInvariantValue)) {
            invariant.add(d.id);
            toHoist.push(i);
            changed = true;
          }
        }
      }
    }
    if (toHoist.length === 0) continue;
    const pre = getOrCreatePreheader(f, loop.header, loop.latches, cfg.preds.get(loop.header) ?? []);
    if (!pre) continue;
    for (const name of loop.body) {
      const b = cfg.blocks.get(name)!;
      b.instrs = b.instrs.filter((i) => !toHoist.includes(i));
    }
    // Keep definition order (an invariant may use another invariant).
    const term = pre.instrs.pop()!;
    pre.instrs.push(...toHoist, term);
    hoisted += toHoist.length;
    // Recompute the CFG map for subsequent loops (blocks changed).
    const fresh = analyze(f);
    cfg.blocks = fresh.blocks;
    cfg.preds = fresh.preds;
  }
  return hoisted;
}

/**
 * The preheader is the unique non-latch predecessor of the header. If the
 * header has several outside predecessors, or that predecessor has other
 * successors, insert a fresh block.
 */
function getOrCreatePreheader(f: Func, header: string, latches: string[], preds: string[]): Block | null {
  const outside = preds.filter((p) => !latches.includes(p));
  if (outside.length === 0) return null;
  const headerBlock = f.blocks.find((b) => b.name === header)!;
  if (outside.length === 1) {
    const p = f.blocks.find((b) => b.name === outside[0])!;
    const t = terminatorOf(p);
    if (t && t.op === 'br') return p;
  }
  // Insert a preheader block.
  let name = header + '.preheader';
  let k = 1;
  while (f.blocks.some((b) => b.name === name)) name = `${header}.preheader.${++k}`;
  const pre: Block = { name, instrs: [{ op: 'br', target: header }] };
  for (const o of outside) {
    const p = f.blocks.find((b) => b.name === o)!;
    const t = terminatorOf(p)!;
    retarget(t, header, name);
  }
  // Phis in the header: entries from outside preds now come from the preheader.
  // With several outside preds we need a phi in the preheader to merge them.
  for (const i of headerBlock.instrs) {
    if (i.op !== 'phi') break;
    const outsideEntries = i.incoming.filter((x) => outside.includes(x.block));
    if (outsideEntries.length === 0) continue;
    if (outsideEntries.length === 1) {
      outsideEntries[0]!.block = name;
    } else {
      const merged: Extract<Instr, { op: 'phi' }> = { op: 'phi', dst: { kind: 'reg', id: nextRegId(f), type: i.dst.type, name: i.dst.name }, incoming: outsideEntries.map((x) => ({ ...x })) };
      pre.instrs.unshift(merged);
      i.incoming = [...i.incoming.filter((x) => !outside.includes(x.block)), { value: merged.dst, block: name }];
    }
  }
  const idx = f.blocks.indexOf(headerBlock);
  f.blocks.splice(idx, 0, pre);
  return pre;
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

import { maxRegId } from './analysis';
function nextRegId(f: Func): number {
  return maxRegId(f) + 1;
}
export { renamePhiPred, successors };
