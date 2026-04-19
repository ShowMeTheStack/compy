/**
 * Decoding the *values* of numeric, character, and string literals from their
 * source spelling. Used by the #if constant-expression evaluator and by the
 * parser/interpreter. Integer math is done in bigint so #if matches C's
 * intmax_t semantics; the interpreter narrows to the declared type afterwards.
 */

export interface IntLiteral {
  value: bigint;
  unsigned: boolean;
  /** minimum rank: 'int' | 'long' | 'llong' from the suffix / magnitude. */
  rank: 'int' | 'long' | 'llong';
}

export interface FloatLiteral {
  value: number;
  /** 'float' | 'double' | 'ldouble' from an f/F or l/L suffix. */
  type: 'float' | 'double' | 'ldouble';
}

export function isFloatLiteral(text: string): boolean {
  // A pp-number is a float iff it has a '.', or a decimal exponent, or a hex
  // 'p' exponent. A leading-0x hex integer must not be mistaken for a float.
  if (/^0[xX]/.test(text)) return /[.pP]/.test(text);
  return /[.]/.test(text) || /[eE]/.test(text);
}

export function parseIntLiteral(text: string): IntLiteral {
  let s = text;
  let unsigned = false;
  let long = 0;
  // Strip suffix (any order of u/l).
  const m = /[uUlL]+$/.exec(s);
  if (m) {
    const suf = m[0].toLowerCase();
    unsigned = suf.includes('u');
    long = (suf.match(/l/g) ?? []).length;
    s = s.slice(0, s.length - m[0].length);
  }
  let value: bigint;
  if (/^0[xX]/.test(s)) value = BigInt(s);
  else if (/^0[0-7]*$/.test(s) && s.length > 1) value = BigInt(parseInt(s, 8));
  else value = BigInt(s);
  const rank: IntLiteral['rank'] = long >= 2 ? 'llong' : long === 1 ? 'long' : 'int';
  return { value, unsigned, rank };
}

export function parseFloatLiteral(text: string): FloatLiteral {
  let s = text;
  let type: FloatLiteral['type'] = 'double';
  const last = s[s.length - 1];
  if (last === 'f' || last === 'F') {
    type = 'float';
    s = s.slice(0, -1);
  } else if (last === 'l' || last === 'L') {
    type = 'ldouble';
    s = s.slice(0, -1);
  }
  return { value: parseCFloat(s), type };
}

function parseCFloat(s: string): number {
  if (/^0[xX]/.test(s)) return parseHexFloat(s);
  return parseFloat(s);
}

function parseHexFloat(s: string): number {
  // 0x<hex>.<hex>p<exp>
  const m = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)$/.exec(s);
  if (!m) return Number(s);
  const intPart = m[1] ?? '';
  const fracPart = m[2] ?? '';
  const exp = parseInt(m[3]!, 10);
  let mantissa = 0;
  for (const c of intPart) mantissa = mantissa * 16 + parseInt(c, 16);
  let scale = 1 / 16;
  for (const c of fracPart) {
    mantissa += parseInt(c, 16) * scale;
    scale /= 16;
  }
  return mantissa * Math.pow(2, exp);
}

/** Decode a character constant like 'a', '\n', '\x41', '\101' to its int value. */
export function parseCharLiteral(text: string): number {
  let s = text;
  if (s.startsWith('L')) s = s.slice(1);
  s = s.slice(1, -1); // strip quotes
  const { value } = decodeEscape(s, 0);
  return value;
}

/** Decode a double-quoted string literal's bytes (NUL terminator excluded). */
export function parseStringLiteral(text: string): number[] {
  let s = text;
  if (s.startsWith('L')) s = s.slice(1);
  s = s.slice(1, -1); // strip quotes
  const out: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\') {
      const { value, next } = decodeEscape(s, i);
      out.push(value & 0xff);
      i = next;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
      i++;
    }
  }
  return out;
}

const SIMPLE_ESCAPES: Record<string, number> = {
  n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11, '?': 63,
};

/** Decode one character (possibly an escape) starting at index i. */
function decodeEscape(s: string, i: number): { value: number; next: number } {
  if (s[i] !== '\\') return { value: s.charCodeAt(i), next: i + 1 };
  const c = s[i + 1]!;
  if (c === 'x') {
    let j = i + 2;
    let hex = '';
    while (j < s.length && /[0-9a-fA-F]/.test(s[j]!)) hex += s[j++]!;
    return { value: parseInt(hex || '0', 16), next: j };
  }
  if (c >= '0' && c <= '7') {
    let j = i + 1;
    let oct = '';
    while (j < s.length && oct.length < 3 && s[j]! >= '0' && s[j]! <= '7') oct += s[j++]!;
    return { value: parseInt(oct, 8), next: j };
  }
  const v = SIMPLE_ESCAPES[c];
  return { value: v ?? c.charCodeAt(0), next: i + 2 };
}
