/**
 * Compy's intermediate representation: a typed, three-address, control-flow
 * graph IR in the style of LLVM. A module holds globals, string literals, and
 * functions; a function is a list of basic blocks; a block is a straight-line
 * list of instructions ending in exactly one terminator.
 *
 * Design choices made for teaching:
 *  - Integer types carry only a width (i8/i16/i32/i64); signedness lives in the
 *    operation (sdiv vs udiv, sext vs zext, slt vs ult), exactly as in LLVM.
 *  - Comparisons produce an i1 that is zero-extended when C needs an int.
 *  - Locals start life as `alloca` stack slots with explicit loads and stores
 *    (what clang -O0 emits); the mem2reg pass later promotes them to SSA
 *    registers with phi nodes — the single most illuminating transformation a
 *    student can watch.
 *  - Pointers are an opaque 32-bit `ptr`; address arithmetic is `ptradd`.
 */

import type { CType } from '@compy/cc';

export type IrType = 'i1' | 'i8' | 'i16' | 'i32' | 'i64' | 'f32' | 'f64' | 'ptr' | 'void';

export interface Reg {
  kind: 'reg';
  id: number;
  type: IrType;
  /** Optional source-level name (parameters, promoted locals) for readability. */
  name?: string;
}
export interface Const {
  kind: 'const';
  type: IrType;
  /** Integer/pointer payload (two's complement, not narrowed for i64 safety). */
  i: bigint;
  /** Floating payload. */
  f: number;
}
export type Value = Reg | Const;

export type BinOp =
  | 'add' | 'sub' | 'mul' | 'sdiv' | 'udiv' | 'srem' | 'urem'
  | 'and' | 'or' | 'xor' | 'shl' | 'lshr' | 'ashr'
  | 'fadd' | 'fsub' | 'fmul' | 'fdiv';
export type CmpOp = 'eq' | 'ne' | 'slt' | 'sle' | 'sgt' | 'sge' | 'ult' | 'ule' | 'ugt' | 'uge' | 'oeq' | 'one' | 'olt' | 'ole' | 'ogt' | 'oge';
export type CastOp =
  | 'trunc' | 'sext' | 'zext' // int ↔ int
  | 'sitofp' | 'uitofp' | 'fptosi' | 'fptoui' // int ↔ float
  | 'fpext' | 'fptrunc' // float ↔ float
  | 'ptrtoint' | 'inttoptr' // ptr ↔ int
  | 'bitcast';

export interface Sig {
  ret: IrType;
  params: IrType[];
  variadic: boolean;
}

interface Base {
  /** Source line this instruction came from (for the UI's click-to-source). */
  line?: number;
}

export type Instr =
  | (Base & { op: 'bin'; dst: Reg; opc: BinOp; a: Value; b: Value })
  | (Base & { op: 'cmp'; dst: Reg; opc: CmpOp; a: Value; b: Value })
  | (Base & { op: 'cast'; dst: Reg; opc: CastOp; src: Value })
  | (Base & { op: 'load'; dst: Reg; addr: Value })
  | (Base & { op: 'store'; addr: Value; val: Value })
  | (Base & { op: 'alloca'; dst: Reg; size: Value; align: number; name: string; ctype: string; ct?: CType })
  | (Base & { op: 'global'; dst: Reg; name: string })
  | (Base & { op: 'funcaddr'; dst: Reg; name: string })
  | (Base & { op: 'str'; dst: Reg; id: number })
  | (Base & { op: 'ptradd'; dst: Reg; base: Value; index: Value; scale: number })
  | (Base & { op: 'select'; dst: Reg; cond: Value; a: Value; b: Value })
  | (Base & { op: 'call'; dst?: Reg; callee: string | Value; args: Value[]; sig: Sig })
  | (Base & { op: 'memcpy'; dst: Value; src: Value; len: Value })
  | (Base & { op: 'memset'; dst: Value; byte: Value; len: Value })
  | (Base & { op: 'phi'; dst: Reg; incoming: { value: Value; block: string }[] })
  | (Base & { op: 'br'; target: string })
  | (Base & { op: 'condbr'; cond: Value; then: string; else: string })
  | (Base & { op: 'switch'; val: Value; cases: { value: bigint; target: string }[]; default: string })
  | (Base & { op: 'ret'; val?: Value })
  | (Base & { op: 'unreachable' });

export type Terminator = Extract<Instr, { op: 'br' | 'condbr' | 'switch' | 'ret' | 'unreachable' }>;

export interface Block {
  name: string;
  instrs: Instr[];
}

export interface Func {
  name: string;
  params: Reg[];
  ret: IrType;
  variadic: boolean;
  blocks: Block[];
  /** Human-readable C signature for the UI. */
  csig: string;
  /** Pretty names of parameters as declared in C. */
  paramNames: string[];
  /** Whether the function returns a struct through a hidden first pointer argument. */
  sret: boolean;
  line?: number;
}

export interface Reloc {
  offset: number;
  kind: 'global' | 'func' | 'str';
  ref: string | number;
  /** Added to the resolved address. */
  addend: number;
}

export interface Global {
  name: string;
  size: number;
  align: number;
  /** null → zero-initialized (bss). */
  init: Uint8Array | null;
  relocs: Reloc[];
  readonly: boolean;
  ctype: string;
  ct?: CType;
  /** Internal linkage (static). */
  internal: boolean;
}

export interface Module {
  functions: Func[];
  globals: Global[];
  /** NUL-terminated string literal bytes, indexed by `str` instructions. */
  strings: Uint8Array[];
  /** Names called but not defined here (libc natives). */
  externs: string[];
}

// -- helpers -----------------------------------------------------------------

export function isTerminator(i: Instr): i is Terminator {
  return i.op === 'br' || i.op === 'condbr' || i.op === 'switch' || i.op === 'ret' || i.op === 'unreachable';
}

export function constInt(type: IrType, i: bigint | number): Const {
  return { kind: 'const', type, i: normalize(type, BigInt(i)), f: 0 };
}
export function constFloat(type: IrType, f: number): Const {
  return { kind: 'const', type, i: 0n, f: type === 'f32' ? Math.fround(f) : f };
}

export function bits(t: IrType): number {
  switch (t) {
    case 'i1': return 1;
    case 'i8': return 8;
    case 'i16': return 16;
    case 'i32': case 'ptr': case 'f32': return 32;
    case 'i64': case 'f64': return 64;
    case 'void': return 0;
  }
}
export function bytesOf(t: IrType): number {
  return Math.max(1, Math.ceil(bits(t) / 8));
}
export function isIntType(t: IrType): boolean {
  return t === 'i1' || t === 'i8' || t === 'i16' || t === 'i32' || t === 'i64' || t === 'ptr';
}
export function isFloatType(t: IrType): boolean {
  return t === 'f32' || t === 'f64';
}

/** Two's-complement normalize into the signed range of the type's width. */
export function normalize(type: IrType, v: bigint): bigint {
  const w = bits(type);
  if (w === 0) return 0n;
  if (type === 'ptr') return BigInt.asUintN(32, v);
  return BigInt.asIntN(w, v);
}
export function asUnsigned(type: IrType, v: bigint): bigint {
  return BigInt.asUintN(bits(type), v);
}

/** Successor block names of a terminator. */
export function successors(t: Instr): string[] {
  switch (t.op) {
    case 'br': return [t.target];
    case 'condbr': return t.then === t.else ? [t.then] : [t.then, t.else];
    case 'switch': {
      const out = [t.default];
      for (const c of t.cases) if (!out.includes(c.target)) out.push(c.target);
      return out;
    }
    default: return [];
  }
}

export function terminatorOf(b: Block): Terminator | null {
  const last = b.instrs[b.instrs.length - 1];
  return last && isTerminator(last) ? last : null;
}

export function blockMap(f: Func): Map<string, Block> {
  const m = new Map<string, Block>();
  for (const b of f.blocks) m.set(b.name, b);
  return m;
}

export function predecessors(f: Func): Map<string, string[]> {
  const preds = new Map<string, string[]>();
  for (const b of f.blocks) preds.set(b.name, []);
  for (const b of f.blocks) {
    const t = terminatorOf(b);
    if (!t) continue;
    for (const s of successors(t)) preds.get(s)?.push(b.name);
  }
  return preds;
}

/** The register an instruction defines, if any. */
export function defOf(i: Instr): Reg | null {
  switch (i.op) {
    case 'bin': case 'cmp': case 'cast': case 'load': case 'alloca': case 'global':
    case 'funcaddr': case 'str': case 'ptradd': case 'select': case 'phi':
      return i.dst;
    case 'call':
      return i.dst ?? null;
    default:
      return null;
  }
}

/** Every operand value (registers and constants) an instruction reads. */
export function usesOf(i: Instr): Value[] {
  switch (i.op) {
    case 'bin': case 'cmp': return [i.a, i.b];
    case 'cast': return [i.src];
    case 'load': return [i.addr];
    case 'store': return [i.addr, i.val];
    case 'alloca': return [i.size];
    case 'ptradd': return [i.base, i.index];
    case 'select': return [i.cond, i.a, i.b];
    case 'call': return typeof i.callee === 'string' ? i.args : [i.callee, ...i.args];
    case 'memcpy': return [i.dst, i.src, i.len];
    case 'memset': return [i.dst, i.byte, i.len];
    case 'phi': return i.incoming.map((x) => x.value);
    case 'condbr': return [i.cond];
    case 'switch': return [i.val];
    case 'ret': return i.val ? [i.val] : [];
    default: return [];
  }
}

/** Rewrite every operand through `f` (in place). */
export function mapUses(i: Instr, f: (v: Value) => Value): void {
  switch (i.op) {
    case 'bin': case 'cmp': i.a = f(i.a); i.b = f(i.b); break;
    case 'cast': i.src = f(i.src); break;
    case 'load': i.addr = f(i.addr); break;
    case 'store': i.addr = f(i.addr); i.val = f(i.val); break;
    case 'alloca': i.size = f(i.size); break;
    case 'ptradd': i.base = f(i.base); i.index = f(i.index); break;
    case 'select': i.cond = f(i.cond); i.a = f(i.a); i.b = f(i.b); break;
    case 'call':
      if (typeof i.callee !== 'string') i.callee = f(i.callee);
      i.args = i.args.map(f);
      break;
    case 'memcpy': i.dst = f(i.dst); i.src = f(i.src); i.len = f(i.len); break;
    case 'memset': i.dst = f(i.dst); i.byte = f(i.byte); i.len = f(i.len); break;
    case 'phi': for (const inc of i.incoming) inc.value = f(inc.value); break;
    case 'condbr': i.cond = f(i.cond); break;
    case 'switch': i.val = f(i.val); break;
    case 'ret': if (i.val) i.val = f(i.val); break;
    default: break;
  }
}

/** True when the instruction has no side effects and may be removed if unused. */
export function isPure(i: Instr): boolean {
  switch (i.op) {
    case 'bin':
      // Integer division traps on zero; keep it unless the divisor is a non-zero constant.
      if (i.opc === 'sdiv' || i.opc === 'udiv' || i.opc === 'srem' || i.opc === 'urem') {
        return i.b.kind === 'const' && i.b.i !== 0n;
      }
      return true;
    case 'cmp': case 'cast': case 'global': case 'funcaddr': case 'str': case 'ptradd': case 'select': case 'phi':
      return true;
    default:
      return false;
  }
}

// -- printing ----------------------------------------------------------------

export function fmtValue(v: Value): string {
  if (v.kind === 'reg') return `%${v.name ? v.name + '.' + v.id : v.id}`;
  if (isFloatType(v.type)) return formatFloatConst(v.f);
  return v.i.toString();
}
function formatFloatConst(f: number): string {
  if (Number.isInteger(f) && Math.abs(f) < 1e15) return f.toFixed(1);
  return String(f);
}
function tv(v: Value): string {
  return `${v.type} ${fmtValue(v)}`;
}

export function fmtInstr(i: Instr): string {
  switch (i.op) {
    case 'bin': return `${fmtValue(i.dst)} = ${i.opc} ${tv(i.a)}, ${fmtValue(i.b)}`;
    case 'cmp': return `${fmtValue(i.dst)} = cmp ${i.opc} ${tv(i.a)}, ${fmtValue(i.b)}`;
    case 'cast': return `${fmtValue(i.dst)} = ${i.opc} ${tv(i.src)} to ${i.dst.type}`;
    case 'load': return `${fmtValue(i.dst)} = load ${i.dst.type}, ${fmtValue(i.addr)}`;
    case 'store': return `store ${tv(i.val)}, ${fmtValue(i.addr)}`;
    case 'alloca': return `${fmtValue(i.dst)} = alloca ${i.ctype} ; ${i.name}, ${fmtValue(i.size)} bytes, align ${i.align}`;
    case 'global': return `${fmtValue(i.dst)} = addr @${i.name}`;
    case 'funcaddr': return `${fmtValue(i.dst)} = addr @${i.name}()`;
    case 'str': return `${fmtValue(i.dst)} = addr @.str${i.id}`;
    case 'ptradd': return `${fmtValue(i.dst)} = ptradd ${fmtValue(i.base)}, ${tv(i.index)} * ${i.scale}`;
    case 'select': return `${fmtValue(i.dst)} = select ${fmtValue(i.cond)}, ${tv(i.a)}, ${fmtValue(i.b)}`;
    case 'call': {
      const callee = typeof i.callee === 'string' ? `@${i.callee}` : fmtValue(i.callee);
      const args = i.args.map(tv).join(', ');
      return `${i.dst ? fmtValue(i.dst) + ' = ' : ''}call ${i.sig.ret} ${callee}(${args})`;
    }
    case 'memcpy': return `memcpy ${fmtValue(i.dst)}, ${fmtValue(i.src)}, ${fmtValue(i.len)}`;
    case 'memset': return `memset ${fmtValue(i.dst)}, ${fmtValue(i.byte)}, ${fmtValue(i.len)}`;
    case 'phi': return `${fmtValue(i.dst)} = phi ${i.dst.type} ${i.incoming.map((x) => `[${fmtValue(x.value)}, ${x.block}]`).join(', ')}`;
    case 'br': return `br ${i.target}`;
    case 'condbr': return `br ${tv(i.cond)}, ${i.then}, ${i.else}`;
    case 'switch': return `switch ${tv(i.val)}, default ${i.default} [${i.cases.map((c) => `${c.value}: ${c.target}`).join(', ')}]`;
    case 'ret': return i.val ? `ret ${tv(i.val)}` : 'ret void';
    case 'unreachable': return 'unreachable';
  }
}

export function fmtFunc(f: Func): string {
  const params = f.params.map((p) => `${p.type} ${fmtValue(p)}`).join(', ');
  const lines = [`define ${f.ret} @${f.name}(${params}${f.variadic ? ', ...' : ''}) {`];
  for (const b of f.blocks) {
    lines.push(`${b.name}:`);
    for (const i of b.instrs) lines.push('  ' + fmtInstr(i));
  }
  lines.push('}');
  return lines.join('\n');
}

export function fmtModule(m: Module): string {
  const out: string[] = [];
  m.strings.forEach((s, i) => out.push(`@.str${i} = "${escapeBytes(s)}"`));
  for (const g of m.globals) {
    out.push(`@${g.name} = ${g.internal ? 'internal ' : ''}${g.readonly ? 'constant' : 'global'} ${g.ctype} ; ${g.size} bytes${g.init ? '' : ', zero-initialized'}`);
  }
  if (m.externs.length) out.push(`declare ${m.externs.map((e) => '@' + e).join(', ')}`);
  if (out.length) out.push('');
  for (const f of m.functions) out.push(fmtFunc(f), '');
  return out.join('\n');
}

function escapeBytes(b: Uint8Array): string {
  let s = '';
  for (let k = 0; k < b.length; k++) {
    const c = b[k]!;
    if (c === 0 && k === b.length - 1) break;
    if (c === 10) s += '\\n';
    else if (c === 9) s += '\\t';
    else if (c === 34) s += '\\"';
    else if (c === 92) s += '\\\\';
    else if (c >= 32 && c < 127) s += String.fromCharCode(c);
    else s += '\\x' + c.toString(16).padStart(2, '0');
  }
  return s;
}

/** Count instructions in a function (used by the optimizer stats). */
export function instrCount(f: Func): number {
  let n = 0;
  for (const b of f.blocks) n += b.instrs.length;
  return n;
}

/** Deep-copy a function so passes can produce before/after snapshots. */
export function cloneFunc(f: Func): Func {
  return structuredClone(f);
}
export function cloneModule(m: Module): Module {
  return structuredClone(m);
}
