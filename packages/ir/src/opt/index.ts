import { Module, Func, fmtFunc, instrCount, cloneFunc } from '../ir';
import { simplifyCfg } from './simplifycfg';
import { mem2reg } from './mem2reg';
import { constantFold } from './fold';
import { algebraicSimplify } from './algebra';
import { deadCodeElimination } from './dce';
import { commonSubexpressionElimination } from './cse';
import { loopInvariantCodeMotion } from './licm';
import { inlineCalls } from './inline';

/**
 * The pass manager. Each pass is a named, toggleable unit; the pipeline runs
 * the enabled ones in a sensible order, repeating the scalar passes until
 * nothing changes, and records a before/after snapshot of every function a
 * pass touched so the IDE can show students exactly what each pass did.
 */
export type PassId = 'simplifycfg' | 'mem2reg' | 'inline' | 'constfold' | 'algebra' | 'cse' | 'dce' | 'licm';

export interface PassInfo {
  id: PassId;
  name: string;
  /** One-paragraph explanation shown in the IDE. */
  description: string;
}

export const PASSES: PassInfo[] = [
  {
    id: 'simplifycfg',
    name: 'Simplify CFG',
    description:
      'Cleans up the control-flow graph: folds branches on constant conditions, deletes blocks nothing can reach, threads jumps through empty blocks, and merges a block into its only predecessor.',
  },
  {
    id: 'mem2reg',
    name: 'Promote memory to registers (mem2reg)',
    description:
      'A local variable whose address is never taken does not need a stack slot. Its loads and stores become SSA registers, and where control flow merges a phi node chooses between the values that arrive on each edge. This is SSA construction (Cytron et al.).',
  },
  {
    id: 'inline',
    name: 'Inline small functions',
    description:
      'Replaces a call to a small, non-recursive function with a copy of its body: parameters become the arguments, returns become branches to a continuation block. It removes call overhead and, more importantly, exposes the callee to every other optimization at the call site.',
  },
  {
    id: 'constfold',
    name: 'Constant folding & propagation',
    description:
      'An operation whose inputs are all constants is computed now instead of at run time, and the constant result replaces every use. Folding feeds itself: once one value is known, the operations using it may become foldable too.',
  },
  {
    id: 'algebra',
    name: 'Algebraic simplification & strength reduction',
    description:
      'Applies identities (x+0 → x, x*1 → x, x−x → 0, x^x → 0) and replaces expensive operations by cheaper ones: multiply by a power of two becomes a shift, unsigned divide becomes a shift, unsigned remainder becomes a mask.',
  },
  {
    id: 'cse',
    name: 'Common-subexpression elimination',
    description:
      'If a dominating instruction already computed exactly the same expression from the same operands, reuse its result instead of computing it again (global value numbering over the dominator tree).',
  },
  {
    id: 'dce',
    name: 'Dead code elimination',
    description:
      'Removes pure instructions whose results are never used. Many passes leave such debris behind; DCE sweeps it up, repeatedly, since removing one instruction can orphan another.',
  },
  {
    id: 'licm',
    name: 'Loop-invariant code motion',
    description:
      'An instruction inside a loop whose operands do not change between iterations computes the same value every time. It is hoisted into a preheader block that runs once before the loop.',
  },
];

export interface PassRecord {
  pass: PassId;
  /** Function name (or '*' for module-level passes). */
  fn: string;
  before: string;
  after: string;
  instrsBefore: number;
  instrsAfter: number;
  changes: number;
  /** Which pipeline iteration produced this record. */
  round: number;
}

export interface OptimizeResult {
  module: Module;
  records: PassRecord[];
  rounds: number;
}

export const DEFAULT_PASSES: PassId[] = ['simplifycfg', 'mem2reg', 'inline', 'constfold', 'algebra', 'cse', 'dce', 'licm'];

type FnPass = (f: Func) => number;
const FN_PASSES: Record<Exclude<PassId, 'inline'>, FnPass> = {
  simplifycfg: simplifyCfg,
  mem2reg,
  constfold: constantFold,
  algebra: algebraicSimplify,
  cse: commonSubexpressionElimination,
  dce: deadCodeElimination,
  licm: loopInvariantCodeMotion,
};

export function optimize(input: Module, enabled: PassId[] = DEFAULT_PASSES, maxRounds = 4): OptimizeResult {
  const m = structuredClone(input);
  const on = new Set(enabled);
  const records: PassRecord[] = [];

  const runFnPass = (id: Exclude<PassId, 'inline'>, round: number): number => {
    if (!on.has(id)) return 0;
    let total = 0;
    for (const f of m.functions) {
      const before = fmtFunc(f);
      const nBefore = instrCount(f);
      const changes = FN_PASSES[id](f);
      const after = fmtFunc(f);
      if (changes > 0 && before !== after) {
        records.push({ pass: id, fn: f.name, before, after, instrsBefore: nBefore, instrsAfter: instrCount(f), changes, round });
        total += changes;
      }
    }
    return total;
  };
  const runInline = (round: number): number => {
    if (!on.has('inline')) return 0;
    const before = new Map(m.functions.map((f) => [f.name, fmtFunc(f)] as const));
    const sizes = new Map(m.functions.map((f) => [f.name, instrCount(f)] as const));
    const n = inlineCalls(m);
    if (n > 0) {
      for (const f of m.functions) {
        const after = fmtFunc(f);
        if (before.get(f.name) !== after) records.push({ pass: 'inline', fn: f.name, before: before.get(f.name)!, after, instrsBefore: sizes.get(f.name)!, instrsAfter: instrCount(f), changes: n, round });
      }
    }
    return n;
  };

  // Round 0: structure.
  runFnPass('simplifycfg', 0);
  runFnPass('mem2reg', 0);
  runInline(0);
  runFnPass('simplifycfg', 0);
  runFnPass('mem2reg', 0);
  let rounds = 1;
  for (; rounds <= maxRounds; rounds++) {
    let changes = 0;
    changes += runFnPass('constfold', rounds);
    changes += runFnPass('algebra', rounds);
    changes += runFnPass('cse', rounds);
    changes += runFnPass('dce', rounds);
    changes += runFnPass('simplifycfg', rounds);
    changes += runFnPass('licm', rounds);
    if (changes === 0) break;
  }
  // Inlining may have left dead copies; final sweep.
  runFnPass('dce', rounds);
  runFnPass('simplifycfg', rounds);
  return { module: m, records, rounds };
}

export { simplifyCfg, mem2reg, constantFold, algebraicSimplify, deadCodeElimination, commonSubexpressionElimination, loopInvariantCodeMotion, inlineCalls, cloneFunc };
export * from './analysis';
