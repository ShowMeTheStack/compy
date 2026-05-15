import * as T from '@cide/cc';

/**
 * A runtime C value: integers, enums, booleans, and pointers are held in `i`
 * (a bigint, so 64-bit `long long` and unsigned wraparound are exact); floating
 * values are held in `f`. Every value carries its C type so conversions,
 * pointer scaling, and narrowing follow the standard.
 */
export interface Val {
  type: T.CType;
  i: bigint;
  f: number;
}

export function intVal(type: T.CType, i: bigint): Val {
  return { type, i: narrow(type, i), f: 0 };
}

export function floatVal(type: T.CType, f: number): Val {
  return { type, i: 0n, f: type.kind === 'float' && type.bytes === 4 ? Math.fround(f) : f };
}

export function ptrVal(type: T.CType, addr: number): Val {
  return { type, i: BigInt(addr >>> 0), f: 0 };
}

export function isFloatVal(v: Val): boolean {
  return v.type.kind === 'float';
}

/** The numeric address held by a pointer/integer value. */
export function addrOf(v: Val): number {
  return Number(v.i & 0xffffffffn);
}

/** Truth test for control flow (0 / null pointer / 0.0 → false). */
export function isTruthy(v: Val): boolean {
  return v.type.kind === 'float' ? v.f !== 0 : v.i !== 0n;
}

/** Narrow an integer bigint to the value representable in `type`. */
export function narrow(type: T.CType, i: bigint): bigint {
  if (type.kind === 'float') return 0n;
  if (type.kind === 'bool') return i === 0n ? 0n : 1n;
  const bytes = type.kind === 'int' ? type.bytes : 4; // pointer/enum = 4
  const bits = BigInt(bytes * 8);
  const mask = (1n << bits) - 1n;
  let v = ((i % (1n << bits)) + (1n << bits)) % (1n << bits); // mod 2^bits, non-negative
  v &= mask;
  const signed = T.isSignedInt(type) && type.kind !== 'pointer';
  if (signed && (v & (1n << (bits - 1n))) !== 0n) v -= 1n << bits;
  return v;
}

/** Convert a value to a target type (cast / assignment / argument passing). */
export function convert(v: Val, to: T.CType): Val {
  if (to.kind === 'float') {
    const n = v.type.kind === 'float' ? v.f : Number(v.i);
    return floatVal(to, n);
  }
  if (to.kind === 'bool') {
    const truthy = isTruthy(v);
    return intVal(to, truthy ? 1n : 0n);
  }
  // target is integer / enum / pointer
  if (v.type.kind === 'float') {
    return intVal(to, BigInt(Math.trunc(v.f)));
  }
  return intVal(to, v.i);
}

/** The bigint magnitude used for pointer scaling / indexing. */
export function asInt(v: Val): bigint {
  return v.type.kind === 'float' ? BigInt(Math.trunc(v.f)) : v.i;
}
