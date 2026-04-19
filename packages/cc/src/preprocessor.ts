import { Token, Span, Pos } from './token';
import { Diagnostic } from './diagnostic';
import { lex } from './lexer';
import { parseIntLiteral, parseCharLiteral, isFloatLiteral } from './literals';

/**
 * The C preprocessor (translation phase 4). Handles #include over a pluggable
 * file resolver, object- and function-like macros with `#` (stringize) and `##`
 * (paste), the full conditional family (#if/#ifdef/#ifndef/#elif/#else/#endif)
 * with an integer constant-expression evaluator, #undef, #error/#warning,
 * #pragma once, #line, and the dynamic predefined macros __FILE__, __LINE__,
 * __DATE__, __TIME__, __STDC__. Macro expansion uses hide-sets (Prosser's
 * algorithm) so recursive macros terminate.
 *
 * Every expansion/include/conditional is reported through `onEvent` so the IDE
 * can render a "preprocessor lens".
 */

export interface Macro {
  name: string;
  objectLike: boolean;
  params: string[];
  variadic: boolean;
  body: Token[];
  span: Span;
}

export type PPEventKind = 'define' | 'undef' | 'expand' | 'include' | 'cond';

export interface PPEvent {
  kind: PPEventKind;
  name?: string;
  span: Span;
  detail?: string;
}

export interface PreprocessOptions {
  file?: string;
  /** Directories searched for <angle> includes. */
  systemDirs?: string[];
  /** Extra directories searched for "quote" includes (after the file's dir). */
  quoteDirs?: string[];
  /** Predefined object macros (name → replacement text). */
  predefined?: Record<string, string>;
  /** Resolve an absolute VFS path to its text, or null if absent. */
  readFile?: (path: string) => string | null;
  onEvent?: (e: PPEvent) => void;
  /** Deterministic __DATE__/__TIME__ for reproducible builds & tests. */
  date?: string;
  time?: string;
  maxIncludeDepth?: number;
}

export interface PreprocessResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
  macros: Map<string, Macro>;
}

interface CondFrame {
  parentActive: boolean;
  active: boolean;
  taken: boolean;
  seenElse: boolean;
}

export function preprocess(source: string, opts: PreprocessOptions = {}): PreprocessResult {
  return new Preprocessor(opts).run(source);
}

class Preprocessor {
  private readonly macros = new Map<string, Macro>();
  private readonly diagnostics: Diagnostic[] = [];
  private readonly output: Token[] = [];
  private readonly cond: CondFrame[] = [];
  private readonly fileStack: string[] = [];
  private readonly onceGuard = new Set<string>();
  private readonly onEvent: (e: PPEvent) => void;
  private readonly date: string;
  private readonly time: string;
  private readonly maxDepth: number;
  private steps = 0;

  constructor(private readonly opts: PreprocessOptions) {
    this.onEvent = opts.onEvent ?? (() => {});
    this.date = opts.date ?? 'Jan  1 2026';
    this.time = opts.time ?? '00:00:00';
    this.maxDepth = opts.maxIncludeDepth ?? 64;
    // Seed predefined macros.
    const pre: Record<string, string> = { __STDC__: '1', __STDC_VERSION__: '199409L', ...opts.predefined };
    for (const [name, text] of Object.entries(pre)) {
      const toks = lex(text, '<predefined>').tokens.filter((t) => t.kind !== 'eof');
      this.macros.set(name, { name, objectLike: true, params: [], variadic: false, body: toks, span: toks[0]?.span ?? zeroSpan(name) });
    }
  }

  run(source: string): PreprocessResult {
    const file = this.opts.file ?? '<source>';
    const { tokens, diagnostics } = lex(source, file);
    this.diagnostics.push(...diagnostics);
    this.processFile(tokens, file);
    if (this.cond.length > 0) {
      this.error('unterminated #if / #ifdef', this.cond[this.cond.length - 1]!.parentActive ? tokens[tokens.length - 1]!.span : zeroSpan(file));
    }
    this.output.push(eofToken(file));
    return { tokens: this.output, diagnostics: this.diagnostics, macros: this.macros };
  }

  private get currentFile(): string {
    return this.fileStack[this.fileStack.length - 1] ?? this.opts.file ?? '<source>';
  }

  private active(): boolean {
    return this.cond.length === 0 || this.cond[this.cond.length - 1]!.active;
  }

  // -- top-level file processing --------------------------------------------

  private processFile(tokens: Token[], file: string): void {
    this.fileStack.push(file);
    let i = 0;
    while (i < tokens.length && tokens[i]!.kind !== 'eof') {
      const t = tokens[i]!;
      if (t.kind === 'punct' && t.value === '#' && t.atBol) {
        // Directive: gather the rest of the logical line.
        i++;
        const line: Token[] = [];
        while (i < tokens.length && tokens[i]!.kind !== 'eof' && !tokens[i]!.atBol) {
          line.push(tokens[i]!);
          i++;
        }
        this.handleDirective(t, line);
      } else if (this.active()) {
        const run: Token[] = [];
        while (i < tokens.length && tokens[i]!.kind !== 'eof' && !(tokens[i]!.kind === 'punct' && tokens[i]!.value === '#' && tokens[i]!.atBol)) {
          run.push(tokens[i]!);
          i++;
        }
        for (const out of this.expand(run)) this.output.push(out);
      } else {
        // Skipped region: drop content, but keep scanning for directives.
        while (i < tokens.length && tokens[i]!.kind !== 'eof' && !(tokens[i]!.kind === 'punct' && tokens[i]!.value === '#' && tokens[i]!.atBol)) {
          i++;
        }
      }
    }
    this.fileStack.pop();
  }

  // -- directives ------------------------------------------------------------

  private handleDirective(hash: Token, line: Token[]): void {
    const first = line[0];
    if (!first) return; // null directive: `#` alone
    const name = first.value;
    const rest = line.slice(1);

    // Conditionals must always be handled to keep the stack balanced.
    switch (name) {
      case 'if':
        return this.doIf(this.evalConditionActive() ? this.evalConstExpr(rest, hash.span) !== 0n : false, hash.span);
      case 'ifdef':
        return this.doIf(this.evalConditionActive() && this.isDefined(rest, hash.span), hash.span);
      case 'ifndef':
        return this.doIf(this.evalConditionActive() && !this.isDefined(rest, hash.span), hash.span);
      case 'elif':
        return this.doElif(rest, hash.span);
      case 'else':
        return this.doElse(hash.span);
      case 'endif':
        if (this.cond.length === 0) this.error('#endif without #if', hash.span);
        else this.cond.pop();
        return;
    }

    if (!this.active()) return; // other directives are inert in skipped regions

    switch (name) {
      case 'define':
        return this.doDefine(rest, hash.span);
      case 'undef':
        return this.doUndef(rest, hash.span);
      case 'include':
        return this.doInclude(rest, hash.span);
      case 'error':
        return this.error('#error ' + spell(rest), hash.span);
      case 'warning':
        return this.warn('#warning ' + spell(rest), hash.span);
      case 'pragma':
        return this.doPragma(rest);
      case 'line':
        return; // accepted, no effect on our line tracking
      default:
        if (first.kind === 'ppnum') return; // GNU line marker: `# 12 "file"`
        this.warn(`unknown preprocessing directive #${name}`, hash.span);
    }
  }

  /** True if the enclosing conditional context is active (parent for a new #if). */
  private evalConditionActive(): boolean {
    return this.active();
  }

  private doIf(condTrue: boolean, span: Span): void {
    const parentActive = this.active();
    const active = parentActive && condTrue;
    this.cond.push({ parentActive, active, taken: active, seenElse: false });
    this.onEvent({ kind: 'cond', span, detail: active ? 'taken' : 'skipped' });
  }

  private doElif(rest: Token[], span: Span): void {
    const top = this.cond[this.cond.length - 1];
    if (!top) return this.error('#elif without #if', span);
    if (top.seenElse) return this.error('#elif after #else', span);
    if (top.taken || !top.parentActive) {
      top.active = false;
    } else {
      top.active = this.evalConstExpr(rest, span) !== 0n;
      if (top.active) top.taken = true;
    }
  }

  private doElse(span: Span): void {
    const top = this.cond[this.cond.length - 1];
    if (!top) return this.error('#else without #if', span);
    if (top.seenElse) return this.error('duplicate #else', span);
    top.seenElse = true;
    top.active = top.parentActive && !top.taken;
    if (top.active) top.taken = true;
  }

  private isDefined(rest: Token[], span: Span): boolean {
    const id = rest[0];
    if (!id || id.kind !== 'id') {
      this.error('macro name missing', span);
      return false;
    }
    return this.macros.has(id.value);
  }

  private doDefine(rest: Token[], span: Span): void {
    const nameTok = rest[0];
    if (!nameTok || nameTok.kind !== 'id') return this.error('macro name must be an identifier', span);
    const name = nameTok.value;
    let body: Token[];
    let params: string[] = [];
    let variadic = false;
    let objectLike = true;
    // Function-like iff '(' immediately follows the name with no space.
    const lparen = rest[1];
    if (lparen && lparen.kind === 'punct' && lparen.value === '(' && !lparen.spaceBefore) {
      objectLike = false;
      let i = 2;
      while (i < rest.length && !(rest[i]!.kind === 'punct' && rest[i]!.value === ')')) {
        const p = rest[i]!;
        if (p.kind === 'punct' && p.value === '...') {
          variadic = true;
          params.push('__VA_ARGS__');
          i++;
          break;
        }
        if (p.kind === 'id') params.push(p.value);
        else if (!(p.kind === 'punct' && p.value === ',')) this.error('bad macro parameter', p.span);
        i++;
        if (i < rest.length && rest[i]!.kind === 'punct' && rest[i]!.value === ',') i++;
      }
      // Skip to ')'.
      while (i < rest.length && !(rest[i]!.kind === 'punct' && rest[i]!.value === ')')) i++;
      body = rest.slice(i + 1);
    } else {
      body = rest.slice(1);
    }
    this.macros.set(name, { name, objectLike, params, variadic, body, span });
    this.onEvent({ kind: 'define', name, span, detail: objectLike ? 'object-like' : `function-like(${params.join(', ')})` });
  }

  private doUndef(rest: Token[], span: Span): void {
    const nameTok = rest[0];
    if (!nameTok || nameTok.kind !== 'id') return this.error('macro name must be an identifier', span);
    this.macros.delete(nameTok.value);
    this.onEvent({ kind: 'undef', name: nameTok.value, span });
  }

  private doPragma(rest: Token[]): void {
    if (rest[0]?.value === 'once') this.onceGuard.add(this.currentFile);
    // other pragmas: silently accepted
  }

  private doInclude(rest: Token[], span: Span): void {
    let header = this.readHeaderName(rest);
    if (!header) {
      // Computed include: macro-expand then retry.
      const expanded = this.expand(rest);
      header = this.readHeaderName(expanded);
    }
    if (!header) return this.error('#include expects "FILENAME" or <FILENAME>', span);

    const readFile = this.opts.readFile;
    if (!readFile) return this.error(`cannot include ${header.name}: no file resolver`, span);
    const path = this.resolveInclude(header.name, header.angled, readFile);
    if (path === null) return this.error(`${header.name}: No such file or directory`, span);

    if (this.onceGuard.has(path)) return;
    if (this.fileStack.length >= this.maxDepth) return this.error(`#include nested too deeply (${header.name})`, span);
    if (this.fileStack.includes(path)) return this.error(`#include cycle detected at ${header.name}`, span);

    const text = readFile(path);
    if (text === null) return this.error(`${header.name}: No such file or directory`, span);
    this.onEvent({ kind: 'include', name: header.name, span, detail: path });
    const { tokens, diagnostics } = lex(text, path);
    this.diagnostics.push(...diagnostics);
    this.processFile(tokens, path);
  }

  private readHeaderName(rest: Token[]): { name: string; angled: boolean } | null {
    const first = rest[0];
    if (!first) return null;
    if (first.kind === 'string') return { name: first.value.slice(1, -1), angled: false };
    if (first.kind === 'punct' && first.value === '<') {
      let name = '';
      for (let i = 1; i < rest.length; i++) {
        if (rest[i]!.kind === 'punct' && rest[i]!.value === '>') return { name, angled: true };
        if (i > 1 && rest[i]!.spaceBefore) name += ' ';
        name += rest[i]!.value;
      }
    }
    return null;
  }

  private resolveInclude(name: string, angled: boolean, readFile: (p: string) => string | null): string | null {
    const candidates: string[] = [];
    if (name.startsWith('/')) candidates.push(name);
    if (!angled) {
      candidates.push(joinPath(dirOf(this.currentFile), name));
      for (const d of this.opts.quoteDirs ?? []) candidates.push(joinPath(d, name));
    }
    for (const d of this.opts.systemDirs ?? []) candidates.push(joinPath(d, name));
    for (const c of candidates) if (readFile(c) !== null) return c;
    return null;
  }

  // -- macro expansion (Prosser's algorithm with hide-sets) ------------------

  private expand(input: Token[]): Token[] {
    const out: Token[] = [];
    const work: Token[] = input.slice();
    while (work.length > 0) {
      if (++this.steps > 5_000_000) {
        this.error('preprocessor expansion limit exceeded (recursive macro?)', work[0]!.span);
        break;
      }
      const t = work.shift()!;
      if (t.kind !== 'id') {
        out.push(t);
        continue;
      }
      const name = t.value;
      if (t.hideSet?.has(name)) {
        out.push(t);
        continue;
      }
      const builtin = this.builtin(name, t);
      if (builtin) {
        out.push(builtin);
        continue;
      }
      const m = this.macros.get(name);
      if (!m) {
        out.push(t);
        continue;
      }
      if (m.objectLike) {
        this.onEvent({ kind: 'expand', name, span: t.span });
        const repl = this.subst(m, [], addHide(t.hideSet, name), t);
        work.unshift(...repl);
        continue;
      }
      // Function-like: only an invocation if a '(' follows.
      if (work[0] && work[0].kind === 'punct' && work[0].value === '(') {
        const { args, close } = this.readArgs(work);
        const hs = addHide(intersect(t.hideSet, close.hideSet), name);
        this.onEvent({ kind: 'expand', name, span: t.span, detail: `${args.length} arg(s)` });
        const repl = this.subst(m, args, hs, t);
        work.unshift(...repl);
        continue;
      }
      out.push(t);
    }
    return out;
  }

  private builtin(name: string, at: Token): Token | null {
    switch (name) {
      case '__FILE__':
        return strToken(this.currentFile, at);
      case '__LINE__':
        return numToken(at.span.start.line, at);
      case '__DATE__':
        return strToken(this.date, at);
      case '__TIME__':
        return strToken(this.time, at);
      default:
        return null;
    }
  }

  /** Read a function-like macro's arguments; `work[0]` must be '('. */
  private readArgs(work: Token[]): { args: Token[][]; close: Token } {
    work.shift(); // consume '('
    const args: Token[][] = [];
    let cur: Token[] = [];
    let depth = 0;
    let close: Token = { kind: 'punct', value: ')', span: zeroSpan('()'), atBol: false, spaceBefore: false };
    let started = false;
    while (work.length > 0) {
      const t = work.shift()!;
      if (t.kind === 'punct' && t.value === '(') {
        depth++;
        cur.push(t);
        started = true;
      } else if (t.kind === 'punct' && t.value === ')') {
        if (depth === 0) {
          close = t;
          if (started || cur.length > 0) args.push(cur);
          return { args, close };
        }
        depth--;
        cur.push(t);
      } else if (t.kind === 'punct' && t.value === ',' && depth === 0) {
        args.push(cur);
        cur = [];
        started = true;
      } else {
        cur.push(t);
        started = true;
      }
    }
    this.error('unterminated macro argument list', close.span);
    return { args, close };
  }

  private subst(m: Macro, args: Token[][], hs: Set<string>, invoke: Token): Token[] {
    const body = m.body;
    const os: Token[] = [];
    const paramIndex = (t: Token): number => (t.kind === 'id' ? m.params.indexOf(t.value) : -1);
    const argOf = (idx: number): Token[] => this.gatherArg(m, args, idx);
    const expandedArg = (idx: number): Token[] => this.expand(argOf(idx).slice());

    for (let i = 0; i < body.length; i++) {
      const t = body[i]!;
      const next = body[i + 1];
      // # param  → stringize
      if (t.kind === 'punct' && t.value === '#' && next && paramIndex(next) >= 0) {
        os.push(stringize(argOf(paramIndex(next)), t));
        i++;
        continue;
      }
      // ## rhs   → paste onto the previous output token
      if (t.kind === 'punct' && t.value === '##' && next) {
        const pi = paramIndex(next);
        const rhs = pi >= 0 ? argOf(pi).slice() : [clone(next)];
        this.pasteInto(os, rhs);
        i++;
        continue;
      }
      const pi = paramIndex(t);
      if (pi >= 0) {
        const followedByPaste = next && next.kind === 'punct' && next.value === '##';
        const arg = followedByPaste ? argOf(pi).slice() : expandedArg(pi);
        if (arg.length === 0) os.push(placemarker(t));
        else for (const a of arg) os.push(cloneWithSpace(a, t));
        continue;
      }
      os.push(clone(t));
    }

    // Drop placemarkers and stamp the hide-set on every produced token.
    const result: Token[] = [];
    for (const t of os) {
      if (t.placemarker) continue;
      result.push({ ...t, hideSet: union(t.hideSet, hs), fromMacro: m.name, span: invoke.span });
    }
    return result;
  }

  /** The tokens for parameter `idx`, folding trailing args into __VA_ARGS__. */
  private gatherArg(m: Macro, args: Token[][], idx: number): Token[] {
    if (m.variadic && idx === m.params.length - 1) {
      const rest = args.slice(idx);
      const out: Token[] = [];
      rest.forEach((a, k) => {
        if (k > 0) out.push({ kind: 'punct', value: ',', span: zeroSpan(','), atBol: false, spaceBefore: false });
        out.push(...a);
      });
      return out;
    }
    return args[idx] ?? [];
  }

  private pasteInto(os: Token[], rhs: Token[]): void {
    // Find the last non-placemarker LHS token.
    let lhs: Token | undefined;
    while (os.length > 0) {
      const top = os[os.length - 1]!;
      if (top.placemarker) {
        os.pop();
        continue;
      }
      lhs = os.pop();
      break;
    }
    const rhsHead = rhs.find((t) => !t.placemarker);
    if (!lhs && !rhsHead) return; // both empty
    if (!lhs) {
      os.push(...rhs.filter((t) => !t.placemarker));
      return;
    }
    if (!rhsHead) {
      os.push(lhs);
      return;
    }
    const pasted = pasteTokens(lhs, rhsHead);
    os.push(...pasted);
    // push the remainder of rhs after its head
    const headIdx = rhs.indexOf(rhsHead);
    for (let k = headIdx + 1; k < rhs.length; k++) if (!rhs[k]!.placemarker) os.push(rhs[k]!);
  }

  // -- constant expression evaluation (#if / #elif) --------------------------

  private evalConstExpr(rest: Token[], span: Span): bigint {
    if (rest.length === 0) {
      this.error('#if with no expression', span);
      return 0n;
    }
    const replaced = this.replaceDefined(rest, span);
    const expanded = this.expand(replaced);
    try {
      return new ConstEval(expanded, (msg, s) => this.error(msg, s), span).eval();
    } catch {
      return 0n;
    }
  }

  /** Replace `defined X` / `defined(X)` with 1/0 before macro expansion. */
  private replaceDefined(rest: Token[], span: Span): Token[] {
    const out: Token[] = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]!;
      if (t.kind === 'id' && t.value === 'defined') {
        let j = i + 1;
        let paren = false;
        if (rest[j] && rest[j]!.kind === 'punct' && rest[j]!.value === '(') {
          paren = true;
          j++;
        }
        const id = rest[j];
        if (!id || id.kind !== 'id') {
          this.error('operator "defined" requires an identifier', span);
          out.push(numToken(0, t));
          i = j;
          continue;
        }
        out.push(numToken(this.macros.has(id.value) ? 1 : 0, t));
        j++;
        if (paren) {
          if (rest[j] && rest[j]!.kind === 'punct' && rest[j]!.value === ')') j++;
          else this.error('missing ) after "defined"', span);
        }
        i = j - 1;
      } else {
        out.push(t);
      }
    }
    return out;
  }

  // -- diagnostics -----------------------------------------------------------

  private error(message: string, span: Span): void {
    this.diagnostics.push({ severity: 'error', message, span });
  }

  private warn(message: string, span: Span): void {
    this.diagnostics.push({ severity: 'warning', message, span });
  }
}

/** Integer constant-expression evaluator for #if. Signed bigint arithmetic. */
class ConstEval {
  private i = 0;
  constructor(
    private readonly toks: Token[],
    private readonly onError: (msg: string, span: Span) => void,
    private readonly span: Span,
  ) {}

  eval(): bigint {
    const v = this.ternary();
    return v;
  }

  private peek(): Token | undefined {
    return this.toks[this.i];
  }
  private eat(): Token | undefined {
    return this.toks[this.i++];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.kind === 'punct' && t.value === v;
  }

  private ternary(): bigint {
    const c = this.binary(0);
    if (this.isOp('?')) {
      this.eat();
      const a = this.ternary();
      if (this.isOp(':')) this.eat();
      else this.onError('expected : in #if ternary', this.span);
      const b = this.ternary();
      return c !== 0n ? a : b;
    }
    return c;
  }

  // Precedence table for binary operators.
  private static readonly PREC: Record<string, number> = {
    '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
    '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7,
    '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
  };

  private binary(minPrec: number): bigint {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== 'punct') break;
      const prec = ConstEval.PREC[t.value];
      if (prec === undefined || prec < minPrec) break;
      // Short-circuit for && and ||.
      this.eat();
      if (t.value === '&&') {
        const right = this.binary(prec + 1);
        left = left !== 0n && right !== 0n ? 1n : 0n;
        continue;
      }
      if (t.value === '||') {
        const right = this.binary(prec + 1);
        left = left !== 0n || right !== 0n ? 1n : 0n;
        continue;
      }
      const right = this.binary(prec + 1);
      left = this.apply(t.value, left, right);
    }
    return left;
  }

  private apply(op: string, a: bigint, b: bigint): bigint {
    switch (op) {
      case '*': return a * b;
      case '/':
        if (b === 0n) { this.onError('division by zero in #if', this.span); return 0n; }
        return a / b;
      case '%':
        if (b === 0n) { this.onError('division by zero in #if', this.span); return 0n; }
        return a % b;
      case '+': return a + b;
      case '-': return a - b;
      case '<<': return a << b;
      case '>>': return a >> b;
      case '<': return a < b ? 1n : 0n;
      case '>': return a > b ? 1n : 0n;
      case '<=': return a <= b ? 1n : 0n;
      case '>=': return a >= b ? 1n : 0n;
      case '==': return a === b ? 1n : 0n;
      case '!=': return a !== b ? 1n : 0n;
      case '&': return a & b;
      case '^': return a ^ b;
      case '|': return a | b;
      default: return 0n;
    }
  }

  private unary(): bigint {
    const t = this.peek();
    if (t && t.kind === 'punct') {
      if (t.value === '+') { this.eat(); return this.unary(); }
      if (t.value === '-') { this.eat(); return -this.unary(); }
      if (t.value === '!') { this.eat(); return this.unary() === 0n ? 1n : 0n; }
      if (t.value === '~') { this.eat(); return ~this.unary(); }
    }
    return this.primary();
  }

  private primary(): bigint {
    const t = this.eat();
    if (!t) {
      this.onError('unexpected end of #if expression', this.span);
      return 0n;
    }
    if (t.kind === 'punct' && t.value === '(') {
      const v = this.ternary();
      if (this.isOp(')')) this.eat();
      else this.onError('expected ) in #if', this.span);
      return v;
    }
    if (t.kind === 'ppnum') {
      if (isFloatLiteral(t.value)) {
        this.onError('floating constant in #if', t.span);
        return 0n;
      }
      return parseIntLiteral(t.value).value;
    }
    if (t.kind === 'char') {
      return BigInt(parseCharLiteral(t.value));
    }
    // Any remaining identifier evaluates to 0 (C89 §6.8.1).
    return 0n;
  }
}

// -- token helpers -----------------------------------------------------------

function clone(t: Token): Token {
  return { ...t, hideSet: t.hideSet ? new Set(t.hideSet) : undefined };
}

function cloneWithSpace(t: Token, at: Token): Token {
  return { ...clone(t), spaceBefore: at.spaceBefore };
}

function placemarker(at: Token): Token {
  return { kind: 'other', value: '', span: at.span, atBol: false, spaceBefore: at.spaceBefore, placemarker: true };
}

function addHide(set: Set<string> | undefined, name: string): Set<string> {
  const s = new Set(set);
  s.add(name);
  return s;
}

function union(a: Set<string> | undefined, b: Set<string> | undefined): Set<string> | undefined {
  if (!a && !b) return undefined;
  const s = new Set(a);
  if (b) for (const x of b) s.add(x);
  return s;
}

function intersect(a: Set<string> | undefined, b: Set<string> | undefined): Set<string> {
  const s = new Set<string>();
  if (a && b) for (const x of a) if (b.has(x)) s.add(x);
  return s;
}

function stringize(argTokens: Token[], at: Token): Token {
  let s = '';
  argTokens.forEach((t, k) => {
    if (t.placemarker) return;
    if (k > 0 && t.spaceBefore) s += ' ';
    s += t.value;
  });
  s = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return { kind: 'string', value: `"${s}"`, span: at.span, atBol: false, spaceBefore: at.spaceBefore };
}

function pasteTokens(a: Token, b: Token): Token[] {
  const spelling = a.value + b.value;
  const { tokens } = lex(spelling, '<paste>');
  const real = tokens.filter((t) => t.kind !== 'eof');
  if (real.length === 0) return [];
  // Preserve the LHS placement flags on the (usually single) pasted token.
  return real.map((t, k) => ({ ...t, atBol: false, spaceBefore: k === 0 ? a.spaceBefore : t.spaceBefore }));
}

function spell(tokens: Token[]): string {
  return tokens.map((t, k) => (k > 0 && t.spaceBefore ? ' ' : '') + t.value).join('');
}

function strToken(text: string, at: Token): Token {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return { kind: 'string', value: `"${escaped}"`, span: at.span, atBol: at.atBol, spaceBefore: at.spaceBefore, hideSet: at.hideSet };
}

function numToken(n: number, at: Token): Token {
  return { kind: 'ppnum', value: String(n), span: at.span, atBol: at.atBol, spaceBefore: at.spaceBefore, hideSet: at.hideSet };
}

function eofToken(file: string): Token {
  return { kind: 'eof', value: '', span: zeroSpan(file), atBol: true, spaceBefore: false };
}

function zeroSpan(file: string): Span {
  const p: Pos = { file, line: 1, col: 1, offset: 0 };
  return { start: p, end: p };
}

// -- path helpers (VFS-agnostic) ---------------------------------------------

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  if (name.startsWith('/')) return name;
  const base = dir.endsWith('/') ? dir : dir + '/';
  const parts: string[] = [];
  for (const seg of (base + name).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}
