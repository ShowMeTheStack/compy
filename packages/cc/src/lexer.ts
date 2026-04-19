import { Token, TokKind, Pos, Span } from './token';
import { Diagnostic } from './diagnostic';

/**
 * The C lexer. Performs translation phases 1–3:
 *   1. (source is already a UTF-8 string)
 *   2. splice `\`-newline continuations
 *   3. strip comments (/* *​/ and, as a friendly extra, //) and tokenize into
 *      preprocessing tokens.
 *
 * Whitespace and newlines are not emitted as tokens; instead each token records
 * `spaceBefore` and `atBol`, which the preprocessor relies on to find directives
 * and to stringize macro arguments. Line splicing keeps line numbers accurate so
 * __LINE__ and diagnostics point at the physical source.
 */

// Multi-char punctuators, longest first so maximal munch is correct.
const PUNCTUATORS = [
  '%:%:', '...', '<<=', '>>=',
  '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '*=', '/=', '%=', '+=', '-=', '&=', '^=', '|=', '##',
  '<:', ':>', '<%', '%>', '%:', // digraphs
  '[', ']', '(', ')', '{', '}', '.', '&', '*', '+', '-', '~', '!', '/', '%',
  '<', '>', '^', '|', '?', ':', ';', '=', ',', '#',
];

export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
}

export function lex(source: string, file = '<source>'): LexResult {
  return new Lexer(source, file).run();
}

class Lexer {
  private i = 0;
  private line = 1;
  private col = 1;
  private atBol = true;
  private spaceBefore = false;
  private readonly tokens: Token[] = [];
  private readonly diagnostics: Diagnostic[] = [];

  constructor(
    private readonly src: string,
    private readonly file: string,
  ) {}

  run(): LexResult {
    while (this.i < this.src.length) {
      if (this.skipTrivia()) continue;
      if (this.i >= this.src.length) break;
      this.scanToken();
    }
    this.push('eof', '', this.here());
    return { tokens: this.tokens, diagnostics: this.diagnostics };
  }

  // -- position bookkeeping --------------------------------------------------

  private here(): Pos {
    return { file: this.file, line: this.line, col: this.col, offset: this.i };
  }

  private peek(k = 0): string {
    return this.src[this.i + k] ?? '';
  }

  /** Advance one character, tracking line/col and folding `\`-newline splices. */
  private advance(): string {
    const c = this.src[this.i]!;
    this.i++;
    if (c === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    // Fold a line-continuation that lands right here (phase 2).
    this.foldContinuation();
    return c;
  }

  private foldContinuation(): void {
    while (this.src[this.i] === '\\' && (this.src[this.i + 1] === '\n' || (this.src[this.i + 1] === '\r' && this.src[this.i + 2] === '\n'))) {
      // consume backslash
      this.i++;
      this.col++;
      if (this.src[this.i] === '\r') this.i++;
      this.i++; // the \n
      this.line++;
      this.col = 1;
    }
  }

  // -- whitespace & comments -------------------------------------------------

  /** Consume whitespace and comments; returns true if anything was consumed. */
  private skipTrivia(): boolean {
    const before = this.i;
    for (;;) {
      const c = this.peek();
      if (c === '\n') {
        this.advance();
        this.atBol = true;
        this.spaceBefore = false;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
        this.advance();
        this.spaceBefore = true;
        continue;
      }
      if (c === '/' && this.peek(1) === '*') {
        this.blockComment();
        this.spaceBefore = true;
        continue;
      }
      if (c === '/' && this.peek(1) === '/') {
        this.lineComment();
        this.spaceBefore = true;
        continue;
      }
      break;
    }
    return this.i !== before;
  }

  private blockComment(): void {
    const start = this.here();
    this.advance();
    this.advance(); // consume /*
    while (this.i < this.src.length && !(this.peek() === '*' && this.peek(1) === '/')) {
      this.advance();
    }
    if (this.i >= this.src.length) {
      this.error('unterminated /* comment', { start, end: this.here() });
      return;
    }
    this.advance();
    this.advance(); // consume */
  }

  private lineComment(): void {
    const start = this.here();
    this.advance();
    this.advance(); // consume //
    while (this.i < this.src.length && this.peek() !== '\n') this.advance();
    this.warn('// line comments are not C89 (accepted here)', { start, end: this.here() }, 'ext/line-comment');
  }

  // -- tokens ----------------------------------------------------------------

  private scanToken(): void {
    const c = this.peek();
    if (isIdentStart(c)) return this.identifierOrPrefixedLiteral();
    if (isDigit(c) || (c === '.' && isDigit(this.peek(1)))) return this.ppNumber();
    if (c === '"') return this.stringLiteral('');
    if (c === "'") return this.charConstant('');
    return this.punctuator();
  }

  /** Identifier, or a prefixed string/char literal (L"…", L'…'). */
  private identifierOrPrefixedLiteral(): void {
    const start = this.here();
    let text = '';
    while (isIdentPart(this.peek())) text += this.advance();
    if (text === 'L' && this.peek() === '"') return this.stringLiteral('L', start, text);
    if (text === 'L' && this.peek() === "'") return this.charConstant('L', start, text);
    this.push('id', text, start);
  }

  /** A preprocessing-number: loose enough to survive ## pasting; parsed later. */
  private ppNumber(): void {
    const start = this.here();
    let text = '';
    if (this.peek() === '.') text += this.advance();
    while (this.i < this.src.length) {
      const c = this.peek();
      if ((c === 'e' || c === 'E' || c === 'p' || c === 'P') && (this.peek(1) === '+' || this.peek(1) === '-')) {
        text += this.advance();
        text += this.advance();
      } else if (isIdentPart(c) || c === '.') {
        text += this.advance();
      } else {
        break;
      }
    }
    this.push('ppnum', text, start);
  }

  private stringLiteral(prefix: string, startPos?: Pos, prefixText = ''): void {
    const start = startPos ?? this.here();
    let text = prefixText;
    text += this.advance(); // opening "
    while (this.i < this.src.length && this.peek() !== '"') {
      if (this.peek() === '\n') break;
      if (this.peek() === '\\') text += this.advance();
      text += this.advance();
    }
    if (this.peek() !== '"') {
      this.error('unterminated string literal', { start, end: this.here() });
    } else {
      text += this.advance(); // closing "
    }
    void prefix;
    this.push('string', text, start);
  }

  private charConstant(prefix: string, startPos?: Pos, prefixText = ''): void {
    const start = startPos ?? this.here();
    let text = prefixText;
    text += this.advance(); // opening '
    while (this.i < this.src.length && this.peek() !== "'") {
      if (this.peek() === '\n') break;
      if (this.peek() === '\\') text += this.advance();
      text += this.advance();
    }
    if (this.peek() !== "'") {
      this.error('unterminated character constant', { start, end: this.here() });
    } else {
      text += this.advance(); // closing '
    }
    void prefix;
    this.push('char', text, start);
  }

  private punctuator(): void {
    const start = this.here();
    for (const p of PUNCTUATORS) {
      if (this.src.startsWith(p, this.i)) {
        for (let k = 0; k < p.length; k++) this.advance();
        this.push('punct', p, start);
        return;
      }
    }
    // Unknown stray character (@, `, $, control chars): emit as 'other'.
    const c = this.advance();
    this.push('other', c, start);
  }

  // -- emit ------------------------------------------------------------------

  private push(kind: TokKind, value: string, start: Pos): void {
    const span: Span = { start, end: this.here() };
    this.tokens.push({
      kind,
      value,
      span,
      atBol: this.atBol,
      spaceBefore: this.spaceBefore,
    });
    this.atBol = false;
    this.spaceBefore = false;
  }

  private warn(message: string, span: Span, code?: string): void {
    this.diagnostics.push({ severity: 'warning', message, span, code });
  }

  private error(message: string, span: Span): void {
    this.diagnostics.push({ severity: 'error', message, span });
  }
}

// -- character classes -------------------------------------------------------

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}
