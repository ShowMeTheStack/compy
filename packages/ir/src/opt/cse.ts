import { Func, Instr, Value, isPure, defOf, fmtValue, mapUses } from '../ir';
import { analyze } from './analysis';

/**
 * Common-subexpression elimination by global value numbering: walking the
 * dominator tree, an instruction that computes exactly what a dominating
 * instruction already computed is replaced by that earlier result.
 */
export function commonSubexpressionElimination(f: Func): number {
  const cfg = analyze(f);
  let changes = 0;
  const subst = new Map<number, Value>();
  const visit = (blockName: string, table: Map<string, Value>): void => {
    const b = cfg.blocks.get(blockName)!;
    const scoped = new Map(table);
    const kept: Instr[] = [];
    for (const i of b.instrs) {
      mapUses(i, (v) => (v.kind === 'reg' && subst.has(v.id) ? subst.get(v.id)! : v));
      const d = defOf(i);
      if (d && isPure(i) && i.op !== 'phi') {
        const key = keyOf(i);
        const prior = scoped.get(key);
        if (prior) {
          subst.set(d.id, prior);
          changes++;
          continue;
        }
        scoped.set(key, d);
      }
      kept.push(i);
    }
    b.instrs = kept;
    for (const c of cfg.domChildren.get(blockName) ?? []) visit(c, scoped);
  };
  visit(f.blocks[0]!.name, new Map());
  if (subst.size) for (const b of f.blocks) for (const i of b.instrs) mapUses(i, (v) => (v.kind === 'reg' && subst.has(v.id) ? subst.get(v.id)! : v));
  return changes;
}

function keyOf(i: Instr): string {
  const v = (x: Value) => (x.kind === 'reg' ? `%${x.id}` : `${x.type}:${fmtValue(x)}`);
  switch (i.op) {
    case 'bin': {
      const comm = ['add', 'mul', 'and', 'or', 'xor', 'fadd', 'fmul'].includes(i.opc);
      const [a, b] = comm ? [v(i.a), v(i.b)].sort() : [v(i.a), v(i.b)];
      return `bin:${i.opc}:${i.dst.type}:${a},${b}`;
    }
    case 'cmp': return `cmp:${i.opc}:${v(i.a)},${v(i.b)}`;
    case 'cast': return `cast:${i.opc}:${i.dst.type}:${v(i.src)}`;
    case 'global': return `global:${i.name}`;
    case 'funcaddr': return `funcaddr:${i.name}`;
    case 'str': return `str:${i.id}`;
    case 'ptradd': return `ptradd:${v(i.base)},${v(i.index)}*${i.scale}`;
    case 'select': return `select:${v(i.cond)},${v(i.a)},${v(i.b)}`;
    default: return `${i.op}:${Math.random()}`;
  }
}
