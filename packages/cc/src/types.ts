/**
 * The C type model with an ILP32, little-endian layout (int/long/pointer = 4,
 * char = 1, short = 2, long long = 8, float = 4, double = 8, _Bool = 1, enum =
 * int). Types carry size and alignment so the interpreter can give every object
 * a real address and the visualizer can render struct layouts. `const`/
 * `volatile` are tracked so the sandbox can flag writes to read-only objects.
 */

interface TypeBase {
  qConst?: boolean;
  qVolatile?: boolean;
}

export type CType =
  | VoidType
  | BoolType
  | IntType
  | FloatType
  | PointerType
  | ArrayType
  | FunctionType
  | StructType
  | UnionType
  | EnumType;

export interface VoidType extends TypeBase {
  kind: 'void';
}
export interface BoolType extends TypeBase {
  kind: 'bool';
}
export interface IntType extends TypeBase {
  kind: 'int';
  bytes: 1 | 2 | 4 | 8;
  signed: boolean;
  /** 'char' | 'short' | 'int' | 'long' | 'llong' — for diagnostics. */
  name: string;
}
export interface FloatType extends TypeBase {
  kind: 'float';
  bytes: 4 | 8;
  name: string;
}
export interface PointerType extends TypeBase {
  kind: 'pointer';
  to: CType;
}
export interface ArrayType extends TypeBase {
  kind: 'array';
  of: CType;
  /** Element count, or null for an incomplete/unspecified array. */
  length: number | null;
  vla: boolean;
}
export interface FunctionType extends TypeBase {
  kind: 'function';
  ret: CType;
  params: CType[];
  variadic: boolean;
  hasProto: boolean;
}
export interface FieldInfo {
  name: string;
  type: CType;
  offset: number;
  bitWidth?: number;
}
export interface StructType extends TypeBase {
  kind: 'struct';
  tag?: string;
  fields: FieldInfo[];
  size: number;
  align: number;
  complete: boolean;
  id: number;
}
export interface UnionType extends TypeBase {
  kind: 'union';
  tag?: string;
  fields: FieldInfo[];
  size: number;
  align: number;
  complete: boolean;
  id: number;
}
export interface EnumType extends TypeBase {
  kind: 'enum';
  tag?: string;
  complete: boolean;
}

// -- canonical scalar types --------------------------------------------------

export const VOID: VoidType = { kind: 'void' };
export const BOOL: BoolType = { kind: 'bool' };
export const CHAR: IntType = { kind: 'int', bytes: 1, signed: true, name: 'char' };
export const SCHAR: IntType = { kind: 'int', bytes: 1, signed: true, name: 'signed char' };
export const UCHAR: IntType = { kind: 'int', bytes: 1, signed: false, name: 'unsigned char' };
export const SHORT: IntType = { kind: 'int', bytes: 2, signed: true, name: 'short' };
export const USHORT: IntType = { kind: 'int', bytes: 2, signed: false, name: 'unsigned short' };
export const INT: IntType = { kind: 'int', bytes: 4, signed: true, name: 'int' };
export const UINT: IntType = { kind: 'int', bytes: 4, signed: false, name: 'unsigned int' };
export const LONG: IntType = { kind: 'int', bytes: 4, signed: true, name: 'long' };
export const ULONG: IntType = { kind: 'int', bytes: 4, signed: false, name: 'unsigned long' };
export const LLONG: IntType = { kind: 'int', bytes: 8, signed: true, name: 'long long' };
export const ULLONG: IntType = { kind: 'int', bytes: 8, signed: false, name: 'unsigned long long' };
export const FLOAT: FloatType = { kind: 'float', bytes: 4, name: 'float' };
export const DOUBLE: FloatType = { kind: 'float', bytes: 8, name: 'double' };
export const INT_ENUM: IntType = INT; // enum constants have type int

export function pointerTo(to: CType): PointerType {
  return { kind: 'pointer', to };
}
export function arrayOf(of: CType, length: number | null, vla = false): ArrayType {
  return { kind: 'array', of, length, vla };
}

// -- size & alignment (ILP32) ------------------------------------------------

export function sizeof(t: CType): number {
  switch (t.kind) {
    case 'void':
      return 1; // GNU extension; keeps pointer arithmetic on void* sane
    case 'bool':
      return 1;
    case 'int':
      return t.bytes;
    case 'float':
      return t.bytes;
    case 'pointer':
      return 4;
    case 'enum':
      return 4;
    case 'array':
      return t.length === null ? 0 : sizeof(t.of) * t.length;
    case 'struct':
    case 'union':
      return t.size;
    case 'function':
      return 1;
  }
}

export function alignof(t: CType): number {
  switch (t.kind) {
    case 'void':
    case 'bool':
      return 1;
    case 'int':
    case 'float':
      return t.bytes;
    case 'pointer':
    case 'enum':
      return 4;
    case 'array':
      return alignof(t.of);
    case 'struct':
    case 'union':
      return t.align;
    case 'function':
      return 1;
  }
}

export function alignUp(n: number, to: number): number {
  return to <= 1 ? n : Math.ceil(n / to) * to;
}

/** Compute struct field offsets, total size, and alignment (with padding). */
export function layoutStruct(fields: { name: string; type: CType; bitWidth?: number }[]): {
  fields: FieldInfo[];
  size: number;
  align: number;
} {
  let offset = 0;
  let align = 1;
  const out: FieldInfo[] = [];
  for (const f of fields) {
    const a = alignof(f.type);
    align = Math.max(align, a);
    offset = alignUp(offset, a);
    out.push({ name: f.name, type: f.type, offset, bitWidth: f.bitWidth });
    offset += sizeof(f.type);
  }
  return { fields: out, size: alignUp(offset, align), align };
}

/** Union layout: every field at offset 0; size = max, align = max. */
export function layoutUnion(fields: { name: string; type: CType; bitWidth?: number }[]): {
  fields: FieldInfo[];
  size: number;
  align: number;
} {
  let size = 0;
  let align = 1;
  const out: FieldInfo[] = [];
  for (const f of fields) {
    align = Math.max(align, alignof(f.type));
    size = Math.max(size, sizeof(f.type));
    out.push({ name: f.name, type: f.type, offset: 0, bitWidth: f.bitWidth });
  }
  return { fields: out, size: alignUp(size, align), align };
}

// -- predicates & conversions ------------------------------------------------

export function isInteger(t: CType): boolean {
  return t.kind === 'int' || t.kind === 'bool' || t.kind === 'enum';
}
export function isArithmetic(t: CType): boolean {
  return isInteger(t) || t.kind === 'float';
}
export function isScalar(t: CType): boolean {
  return isArithmetic(t) || t.kind === 'pointer';
}
export function isSignedInt(t: CType): boolean {
  if (t.kind === 'int') return t.signed;
  return t.kind === 'enum' || t.kind === 'bool' ? true : false;
}

/** Integer conversion rank for the usual arithmetic conversions. */
function intRank(t: CType): number {
  if (t.kind === 'bool') return 0;
  if (t.kind === 'enum') return 4;
  if (t.kind === 'int') return t.bytes;
  return 0;
}

/** Array/function → pointer decay, used in most expression contexts. */
export function decay(t: CType): CType {
  if (t.kind === 'array') return pointerTo(t.of);
  if (t.kind === 'function') return pointerTo(t);
  return t;
}

/** The type produced by the usual arithmetic conversions on a binary op. */
export function usualArithmetic(a: CType, b: CType): CType {
  if (a.kind === 'float' || b.kind === 'float') {
    const abytes = a.kind === 'float' ? a.bytes : 0;
    const bbytes = b.kind === 'float' ? b.bytes : 0;
    return Math.max(abytes, bbytes) === 8 ? DOUBLE : FLOAT;
  }
  // integer promotions: anything smaller than int → int
  const pa = promote(a);
  const pb = promote(b);
  if (typesEqualIgnoringQual(pa, pb)) return pa;
  const ra = intRank(pa);
  const rb = intRank(pb);
  const sa = isSignedInt(pa);
  const sb = isSignedInt(pb);
  if (sa === sb) return ra >= rb ? pa : pb;
  // one signed, one unsigned
  const [signed, unsigned] = sa ? [pa, pb] : [pb, pa];
  const rSigned = intRank(signed);
  const rUnsigned = intRank(unsigned);
  if (rUnsigned >= rSigned) return unsigned;
  return signed; // signed can represent all unsigned values (larger rank)
}

/** Integer promotion: types narrower than int become int. */
export function promote(t: CType): CType {
  if (t.kind === 'bool' || t.kind === 'enum') return INT;
  if (t.kind === 'int' && t.bytes < 4) return INT;
  return t;
}

export function typesEqualIgnoringQual(a: CType, b: CType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'int':
      return a.bytes === (b as IntType).bytes && a.signed === (b as IntType).signed;
    case 'float':
      return a.bytes === (b as FloatType).bytes;
    case 'pointer':
      return typesEqualIgnoringQual(a.to, (b as PointerType).to);
    case 'array':
      return typesEqualIgnoringQual(a.of, (b as ArrayType).of) && a.length === (b as ArrayType).length;
    case 'struct':
    case 'union':
      return a.id === (b as StructType | UnionType).id;
    default:
      return true;
  }
}

export function withQual(t: CType, qConst: boolean, qVolatile: boolean): CType {
  if (!qConst && !qVolatile) return t;
  return { ...t, qConst: qConst || t.qConst, qVolatile: qVolatile || t.qVolatile };
}

export function isConst(t: CType): boolean {
  return !!t.qConst;
}

// -- formatting --------------------------------------------------------------

export function formatType(t: CType): string {
  const q = (t.qConst ? 'const ' : '') + (t.qVolatile ? 'volatile ' : '');
  switch (t.kind) {
    case 'void':
      return q + 'void';
    case 'bool':
      return q + '_Bool';
    case 'int':
      return q + t.name;
    case 'float':
      return q + t.name;
    case 'pointer':
      return q + formatType(t.to) + '*';
    case 'array':
      return `${formatType(t.of)}[${t.length ?? ''}]`;
    case 'function':
      return `${formatType(t.ret)}(${t.params.map(formatType).join(', ')}${t.variadic ? ', ...' : ''})`;
    case 'struct':
      return q + `struct ${t.tag ?? '<anon>'}`;
    case 'union':
      return q + `union ${t.tag ?? '<anon>'}`;
    case 'enum':
      return q + `enum ${t.tag ?? '<anon>'}`;
  }
}
