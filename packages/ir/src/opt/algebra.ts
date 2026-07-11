import { Func, Instr, Value, Reg, constInt, isFloatType, mapUses, asUnsigned, bits } from '../ir';

/**
 * Algebraic simplification and strength reduction: identities such as
 * x+0, x*1, x&x, x^x, x-x; and cheaper equivalents such as x*8 → x<<3,
 * x/8 (unsigned) → x>>3, x%8 (unsigned) → x&7, x*0 → 0, select folds,
 * and double negation.
 */
export function algebraicSimplify(f: Func): number {
  let changes = 0;
  const subst = new Map<number, Value>();
  for (const b of f.blocks) {
    const kept: Instr[] = [];
    for (const i of b.instrs) {
      mapUses(i, (v) => (v.kind === 'reg' && subst.has(v.id) ? subst.get(v.id)! : v));
      const r = simplify(i);
      if (r === null) {
        kept.push(i);
        continue;
      }
      changes++;
      if ('replace' in r) {
        subst.set(r.dst.id, r.replace);
      } else {
        kept.push(r.instr);
      }
    }
    b.instrs = kept;
  }
  if (subst.size) for (const b of f.blocks) for (const i of b.instrs) mapUses(i, (v) => (v.kind === 'reg' && subst.has(v.id) ? subst.get(v.id)! : v));
  return changes;
}

type Rewrite = { dst: Reg; replace: Value } | { instr: Instr };

function isConst(v: Value, n: bigint): boolean {
  return v.kind === 'const' && !isFloatType(v.type) && v.i === n;
}
function sameReg(a: Value, b: Value): boolean {
  return a.kind === 'reg' && b.kind === 'reg' && a.id === b.id;
}
function log2(v: Value): number | null {
  if (v.kind !== 'const' || isFloatType(v.type)) return null;
  const u = asUnsigned(v.type, v.i);
  if (u <= 0n || (u & (u - 1n)) !== 0n) return null;
  let k = 0;
  let x = u;
  while (x > 1n) {
    x >>= 1n;
    k++;
  }
  return k;
}

function simplify(i: Instr): Rewrite | null {
  if (i.op === 'bin') {
    const { opc, a, b, dst } = i;
    if (isFloatType(dst.type)) {
      if (opc === 'fmul' && b.kind === 'const' && b.f === 1) return { dst, replace: a };
      if ((opc === 'fadd' || opc === 'fsub') && b.kind === 'const' && b.f === 0) return { dst, replace: a };
      return null;
    }
    // Canonicalize: constant on the right for commutative ops.
    if ((opc === 'add' || opc === 'mul' || opc === 'and' || opc === 'or' || opc === 'xor') && a.kind === 'const' && b.kind === 'reg') {
      return { instr: { ...i, a: b, b: a } };
    }
    switch (opc) {
      case 'add':
        if (isConst(b, 0n)) return { dst, replace: a };
        break;
      case 'sub':
        if (isConst(b, 0n)) return { dst, replace: a };
        if (sameReg(a, b)) return { dst, replace: constInt(dst.type, 0) };
        break;
      case 'mul': {
        if (isConst(b, 1n)) return { dst, replace: a };
        if (isConst(b, 0n)) return { dst, replace: constInt(dst.type, 0) };
        const k = log2(b);
        if (k !== null && k > 0) return { instr: { ...i, opc: 'shl', b: constInt(dst.type, k) } };
        break;
      }
      case 'udiv': {
        if (isConst(b, 1n)) return { dst, replace: a };
        const k = log2(b);
        if (k !== null && k > 0) return { instr: { ...i, opc: 'lshr', b: constInt(dst.type, k) } };
        break;
      }
      case 'sdiv':
        if (isConst(b, 1n)) return { dst, replace: a };
        break;
      case 'urem': {
        const k = log2(b);
        if (k !== null) return { instr: { ...i, opc: 'and', b: constInt(dst.type, (1n << BigInt(k)) - 1n) } };
        break;
      }
      case 'srem':
        if (isConst(b, 1n)) return { dst, replace: constInt(dst.type, 0) };
        break;
      case 'and':
        if (isConst(b, 0n)) return { dst, replace: constInt(dst.type, 0) };
        if (sameReg(a, b)) return { dst, replace: a };
        if (b.kind === 'const' && asUnsigned(dst.type, b.i) === asUnsigned(dst.type, -1n)) return { dst, replace: a };
        break;
      case 'or':
        if (isConst(b, 0n)) return { dst, replace: a };
        if (sameReg(a, b)) return { dst, replace: a };
        break;
      case 'xor':
        if (isConst(b, 0n)) return { dst, replace: a };
        if (sameReg(a, b)) return { dst, replace: constInt(dst.type, 0) };
        break;
      case 'shl':
      case 'lshr':
      case 'ashr':
        if (isConst(b, 0n)) return { dst, replace: a };
        if (b.kind === 'const' && asUnsigned(b.type, b.i) >= BigInt(bits(dst.type))) return null;
        break;
    }
    return null;
  }
  if (i.op === 'cmp') {
    if (sameReg(i.a, i.b) && !isFloatType(i.a.type)) {
      const t = i.opc === 'eq' || i.opc === 'sle' || i.opc === 'sge' || i.opc === 'ule' || i.opc === 'uge';
      return { dst: i.dst, replace: constInt('i1', t ? 1 : 0) };
    }
    return null;
  }
  if (i.op === 'select') {
    if (sameReg(i.a, i.b) || (i.a.kind === 'const' && i.b.kind === 'const' && i.a.i === i.b.i && i.a.f === i.b.f)) return { dst: i.dst, replace: i.a };
    return null;
  }
  if (i.op === 'ptradd') {
    if (isConst(i.index, 0n)) return { dst: i.dst, replace: i.base };
    return null;
  }
  return null;
}
