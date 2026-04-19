/**
 * Source positions and the preprocessing-token model shared by the lexer,
 * preprocessor, and parser. Keywords are NOT distinguished here: in C they are
 * recognized only at parse time (translation phase 7), after macro expansion,
 * so a macro may legitimately expand to a keyword. The lexer emits identifiers
 * and the parser classifies them.
 */

export interface Pos {
  file: string;
  line: number; // 1-based
  col: number; // 1-based
  offset: number; // 0-based index into the (phase-1) source
}

export interface Span {
  start: Pos;
  end: Pos;
}

export type TokKind =
  | 'id' // identifier (keywords included; classified later)
  | 'ppnum' // preprocessing number; classified as int/float later
  | 'char' // character constant, e.g. 'a', '\n', L'x'
  | 'string' // string literal, e.g. "hi", L"hi"
  | 'punct' // operator or punctuator
  | 'header' // header-name (only produced inside #include handling)
  | 'other' // a stray character (@ ` $ …) — diagnosed if it reaches parsing
  | 'eof';

export interface Token {
  kind: TokKind;
  /** The token spelling as it appeared in source (after line splicing). */
  value: string;
  span: Span;
  /** True if this is the first token on its logical line. */
  atBol: boolean;
  /** True if whitespace or a comment preceded this token. */
  spaceBefore: boolean;
  /** Macro hide-set: names that must not be re-expanded in this token. */
  hideSet?: Set<string>;
  /** Set when this token came from a macro expansion (for the pp lens). */
  fromMacro?: string;
  /** Internal to `##` pasting: an empty operand that vanishes after pasting. */
  placemarker?: boolean;
}

export const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'int',
  'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
  // friendly extras (C99/C11) accepted with a warning off strict mode:
  'inline', 'restrict', '_Bool', '_Complex', 'long long',
]);

/** True for the C89 keyword set only (used by the strict-mode diagnostic). */
export const C89_KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'int',
  'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
]);

export function isKeyword(id: string): boolean {
  return KEYWORDS.has(id);
}
