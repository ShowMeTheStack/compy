import { Func, Instr, Value, Const, IrType, constInt, constFloat, normalize, asUnsigned, bits, isFloatType, mapUses, defOf } from '../ir';
import { castVal } from '../interp';

/**
 * Constant folding and propagation: an instruction whose operands are all
 * constants is computed at compile time and every use of its result becomes
 * that constant. Also folds `select` and phis whose incoming values agree.
 */
export function constantFold(f: Func): number {
  let changes = 0;
  const subst = new Map<number, Value>();
  for (const b of f.blocks) {
    const kept: Instr[] = [];
    for (const i of b.instrs) {
      mapUses(i, (v) => (v.kind === 'reg' && subst.has(v.id) ? subst.get(v.id)! : v));
      const c = foldInstr(i);
      if (c) {
        subst.set(defOf(i)!.id, c);
        changes++;
        continue;
      }
      kept.push(i);
    }
    b.instrs = kept;
  }
  if (subst.size) for (const b of f.blocks) for (const i of b.instrs) mapUses(i, (v) => (v.kind === 'reg' && subst.has(v.id) ? subst.get(v.id)! : v));
  return changes;
}

export function foldInstr(i: Instr): Const | null {
  switch (i.op) {
    case 'bin':
      if (i.a.kind === 'const' && i.b.kind === 'const') return foldBin(i.opc, i.dst.type, i.a, i.b);
      return null;
    case 'cmp':
      if (i.a.kind === 'const' && i.b.kind === 'const') return constInt('i1', foldCmp(i.opc, i.a.type, i.a, i.b) ? 1 : 0);
      return null;
    case 'cast':
      if (i.src.kind === 'const') {
        const r = castVal(i.opc, i.src.type, i.dst.type, isFloatType(i.src.type) ? i.src.f : i.src.i);
        return isFloatType(i.dst.type) ? constFloat(i.dst.type, Number(r)) : constInt(i.dst.type, r as bigint);
      }
      return null;
    case 'select':
      if (i.cond.kind === 'const') {
        const v = i.cond.i !== 0n ? i.a : i.b;
        return v.kind === 'const' ? v : null;
      }
      return null;
    case 'ptradd':
      if (i.base.kind === 'const' && i.index.kind === 'const') return constInt('ptr', i.base.i + i.index.i * BigInt(i.scale));
      return null;
    default:
      return null;
  }
}

export function foldBin(opc: string, type: IrType, a: Const, b: Const): Const | null {
  if (isFloatType(type)) {
    const x = a.f;
    const y = b.f;
    switch (opc) {
      case 'fadd': return constFloat(type, x + y);
      case 'fsub': return constFloat(type, x - y);
      case 'fmul': return constFloat(type, x * y);
      case 'fdiv': return constFloat(type, x / y);
      default: return null;
    }
  }
  const x = a.i;
  const y = b.i;
  const w = BigInt(bits(type));
  switch (opc) {
    case 'add': return constInt(type, x + y);
    case 'sub': return constInt(type, x - y);
    case 'mul': return constInt(type, x * y);
    case 'sdiv': return y === 0n ? null : constInt(type, x / y);
    case 'udiv': return y === 0n ? null : constInt(type, asUnsigned(type, x) / asUnsigned(type, y));
    case 'srem': return y === 0n ? null : constInt(type, x % y);
    case 'urem': return y === 0n ? null : constInt(type, asUnsigned(type, x) % asUnsigned(type, y));
    case 'and': return constInt(type, x & y);
    case 'or': return constInt(type, x | y);
    case 'xor': return constInt(type, x ^ y);
    case 'shl': return constInt(type, x << (asUnsigned(type, y) & (w - 1n)));
    case 'lshr': return constInt(type, asUnsigned(type, x) >> (asUnsigned(type, y) & (w - 1n)));
    case 'ashr': return constInt(type, normalize(type, x) >> (asUnsigned(type, y) & (w - 1n)));
    default: return null;
  }
}

export function foldCmp(opc: string, type: IrType, a: Const, b: Const): boolean {
  if (isFloatType(type)) {
    const x = a.f;
    const y = b.f;
    switch (opc) {
      case 'oeq': return x === y;
      case 'one': return x !== y;
      case 'olt': return x < y;
      case 'ole': return x <= y;
      case 'ogt': return x > y;
      case 'oge': return x >= y;
      default: return false;
    }
  }
  const sx = normalize(type, a.i);
  const sy = normalize(type, b.i);
  const ux = asUnsigned(type, a.i);
  const uy = asUnsigned(type, b.i);
  switch (opc) {
    case 'eq': return ux === uy;
    case 'ne': return ux !== uy;
    case 'slt': return sx < sy;
    case 'sle': return sx <= sy;
    case 'sgt': return sx > sy;
    case 'sge': return sx >= sy;
    case 'ult': return ux < uy;
    case 'ule': return ux <= uy;
    case 'ugt': return ux > uy;
    case 'uge': return ux >= uy;
    default: return false;
  }
}
