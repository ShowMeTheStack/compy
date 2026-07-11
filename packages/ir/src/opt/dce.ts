import { Func, isPure, defOf } from '../ir';
import { useCounts } from './analysis';

/**
 * Dead code elimination: a pure instruction whose result nobody reads is
 * removed. Iterates, because removing one instruction can orphan another.
 */
export function deadCodeElimination(f: Func): number {
  let removed = 0;
  for (;;) {
    const counts = useCounts(f);
    let n = 0;
    for (const b of f.blocks) {
      const before = b.instrs.length;
      b.instrs = b.instrs.filter((i) => {
        const d = defOf(i);
        if (!d) return true;
        if (!isPure(i) && i.op !== 'load' && i.op !== 'alloca') return true;
        if (i.op === 'alloca' && i.size.kind !== 'const') return true;
        return (counts.get(d.id) ?? 0) > 0;
      });
      n += before - b.instrs.length;
    }
    removed += n;
    if (n === 0) return removed;
  }
}
