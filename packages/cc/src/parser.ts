import { Token, Span, Pos } from './token';
import { Diagnostic, CompileError } from './diagnostic';
import { parseIntLiteral, parseFloatLiteral, parseCharLiteral, parseStringLiteral, isFloatLiteral } from './literals';
import * as A from './ast';

/**
 * Recursive-descent parser for C89 plus the friendly extras (mixed
 * declarations, for-init declarations, // comments already handled, long long,
 * _Bool, inline, designated initializers). Consumes the preprocessed token
 * stream. Resolves the two classic C ambiguities using a scoped set of typedef
 * names: declaration-vs-expression and cast-vs-parenthesized-expression.
 */

const STORAGE = new Set(['typedef', 'extern', 'static', 'auto', 'register']);
const QUAL = new Set(['const', 'volatile', 'restrict']);
const TYPESPEC = new Set(['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool']);

const ASSIGN_OPS = new Set(['=', '*=', '/=', '%=', '+=', '-=', '<<=', '>>=', '&=', '^=', '|=']);

const BIN_PREC: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

export interface ParseResult {
  unit: A.TranslationUnit;
  diagnostics: Diagnostic[];
}

export function parse(tokens: Token[], file = '<source>'): ParseResult {
  return new Parser(tokens, file).parseUnit();
}

class Parser {
  private p = 0;
  private readonly toks: Token[];
  private readonly diagnostics: Diagnostic[] = [];
  /** Scoped typedef-name sets (innermost last). */
  private readonly typedefScopes: Set<string>[] = [new Set()];

  constructor(tokens: Token[], private readonly file: string) {
    this.toks = tokens.filter((t) => t.kind !== 'header');
  }

  // -- cursor ----------------------------------------------------------------

  private peek(k = 0): Token {
    return this.toks[this.p + k] ?? this.eof();
  }
  private cur(): Token {
    return this.peek(0);
  }
  private prev(): Token {
    return this.toks[this.p - 1] ?? this.eof();
  }
  private eof(): Token {
    const last = this.toks[this.toks.length - 1];
    return last ?? { kind: 'eof', value: '', span: this.zero(), atBol: true, spaceBefore: false };
  }
  private atEnd(): boolean {
    return this.cur().kind === 'eof';
  }
  private advance(): Token {
    const t = this.cur();
    if (!this.atEnd()) this.p++;
    return t;
  }
  private isPunct(v: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'punct' && t.value === v;
  }
  private isKw(v: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'id' && t.value === v;
  }
  private matchPunct(v: string): boolean {
    if (this.isPunct(v)) {
      this.advance();
      return true;
    }
    return false;
  }
  private matchKw(v: string): boolean {
    if (this.isKw(v)) {
      this.advance();
      return true;
    }
    return false;
  }
  private expectPunct(v: string): Token {
    if (this.isPunct(v)) return this.advance();
    throw this.fail(`expected '${v}' but found '${this.cur().value || '<eof>'}'`);
  }
  private fail(message: string): CompileError {
    return new CompileError(message, this.cur().span);
  }
  private zero(): Span {
    const p: Pos = { file: this.file, line: 1, col: 1, offset: 0 };
    return { start: p, end: p };
  }
  private spanFrom(start: Token): Span {
    return { start: start.span.start, end: this.prev().span.end };
  }

  // -- typedef scope ---------------------------------------------------------

  private pushScope(): void {
    this.typedefScopes.push(new Set());
  }
  private popScope(): void {
    if (this.typedefScopes.length > 1) this.typedefScopes.pop();
  }
  private addTypedef(name: string): void {
    this.typedefScopes[this.typedefScopes.length - 1]!.add(name);
  }
  private removeTypedef(name: string): void {
    // A non-typedef declaration shadows a typedef name in this scope.
    this.typedefScopes[this.typedefScopes.length - 1]!.delete(name);
  }
  private isTypedefName(name: string): boolean {
    for (let i = this.typedefScopes.length - 1; i >= 0; i--) {
      if (this.typedefScopes[i]!.has(name)) return true;
    }
    return false;
  }

  private startsDeclSpecifiers(t = this.cur()): boolean {
    if (t.kind !== 'id') return false;
    if (STORAGE.has(t.value) || QUAL.has(t.value) || TYPESPEC.has(t.value)) return true;
    if (t.value === 'struct' || t.value === 'union' || t.value === 'enum') return true;
    if (t.value === 'inline') return true;
    return this.isTypedefName(t.value);
  }

  // -- translation unit ------------------------------------------------------

  parseUnit(): ParseResult {
    const start = this.cur();
    const decls: A.ExternalDecl[] = [];
    while (!this.atEnd()) {
      try {
        const d = this.parseExternalDecl();
        if (d) decls.push(d);
      } catch (e) {
        if (e instanceof CompileError) {
          this.diagnostics.push({ severity: 'error', message: e.message, span: e.span });
          this.synchronize();
        } else {
          throw e;
        }
      }
    }
    return {
      unit: { kind: 'TranslationUnit', decls, span: this.spanFrom(start) },
      diagnostics: this.diagnostics,
    };
  }

  /** Skip to the next top-level ';' or '}' to recover from a parse error. */
  private synchronize(): void {
    let depth = 0;
    while (!this.atEnd()) {
      if (this.isPunct('{')) depth++;
      else if (this.isPunct('}')) {
        if (depth === 0) {
          this.advance();
          return;
        }
        depth--;
      } else if (this.isPunct(';') && depth === 0) {
        this.advance();
        return;
      }
      this.advance();
    }
  }

  private parseExternalDecl(): A.ExternalDecl | null {
    const start = this.cur();
    const specifiers = this.parseDeclSpecifiers();

    if (this.matchPunct(';')) {
      // A specifier-only declaration (struct/union/enum or typedef with no name).
      return { kind: 'Declaration', specifiers, declarators: [], span: this.spanFrom(start) };
    }

    const first = this.parseDeclarator(false);
    // Function definition?  declarator is a function and body/K&R decls follow.
    if (first.kind === 'FunctionDeclarator' && (this.isPunct('{') || this.startsDeclSpecifiers())) {
      const krDecls: A.Declaration[] = [];
      while (!this.isPunct('{') && !this.atEnd()) {
        krDecls.push(this.parseDeclarationRest(this.cur(), this.parseDeclSpecifiers()));
      }
      const body = this.parseCompound();
      const name = A.declaratorName(first);
      if (name) this.removeTypedef(name);
      return { kind: 'FunctionDef', specifiers, declarator: first, krDecls, body, span: this.spanFrom(start) };
    }

    // Otherwise a declaration: finish the init-declarator list.
    const decl = this.finishDeclaration(start, specifiers, first);
    return decl;
  }

  // -- declarations ----------------------------------------------------------

  private parseDeclaration(): A.Declaration {
    const start = this.cur();
    const specifiers = this.parseDeclSpecifiers();
    return this.parseDeclarationRest(start, specifiers);
  }

  private parseDeclarationRest(start: Token, specifiers: A.DeclSpecifiers): A.Declaration {
    if (this.matchPunct(';')) {
      return { kind: 'Declaration', specifiers, declarators: [], span: this.spanFrom(start) };
    }
    const first = this.parseDeclarator(false);
    return this.finishDeclaration(start, specifiers, first);
  }

  private finishDeclaration(start: Token, specifiers: A.DeclSpecifiers, first: A.Declarator): A.Declaration {
    const isTypedef = specifiers.storage === 'typedef';
    const declarators: A.InitDeclarator[] = [];
    let declarator = first;
    for (;;) {
      const name = A.declaratorName(declarator);
      if (name) {
        if (isTypedef) this.addTypedef(name);
        else this.removeTypedef(name);
      }
      let init: A.Initializer | null = null;
      if (this.matchPunct('=')) init = this.parseInitializer();
      declarators.push({ declarator, init, span: this.spanFrom(start) });
      if (!this.matchPunct(',')) break;
      declarator = this.parseDeclarator(false);
    }
    this.expectPunct(';');
    return { kind: 'Declaration', specifiers, declarators, span: this.spanFrom(start) };
  }

  private parseDeclSpecifiers(): A.DeclSpecifiers {
    const start = this.cur();
    let storage: A.StorageClass | undefined;
    const typeSpecs: A.TypeSpec[] = [];
    let qualConst = false;
    let qualVolatile = false;
    let inline = false;
    let sawTypeSpec = false;

    for (;;) {
      const t = this.cur();
      if (t.kind !== 'id') break;
      const v = t.value;
      if (STORAGE.has(v)) {
        if (storage) this.warnAt(t.span, `multiple storage classes`);
        storage = v as A.StorageClass;
        this.advance();
      } else if (v === 'const') {
        qualConst = true;
        this.advance();
      } else if (v === 'volatile') {
        qualVolatile = true;
        this.advance();
      } else if (v === 'restrict') {
        this.advance(); // accepted, no effect
      } else if (v === 'inline') {
        inline = true;
        this.advance();
      } else if (TYPESPEC.has(v)) {
        typeSpecs.push({ kind: 'BasicType', name: v as A.BasicTypeSpec['name'], span: t.span });
        if (v !== 'signed' && v !== 'unsigned' && v !== 'long' && v !== 'short') sawTypeSpec = true;
        this.advance();
      } else if (v === 'struct' || v === 'union') {
        typeSpecs.push(this.parseStructUnion());
        sawTypeSpec = true;
      } else if (v === 'enum') {
        typeSpecs.push(this.parseEnum());
        sawTypeSpec = true;
      } else if (!sawTypeSpec && this.isTypedefName(v)) {
        typeSpecs.push({ kind: 'TypedefName', name: v, span: t.span });
        sawTypeSpec = true;
        this.advance();
      } else {
        break;
      }
    }
    if (typeSpecs.length === 0) {
      // Implicit int (K&R): accepted with a warning.
      this.warnAt(start.span, 'type defaults to int (implicit int is not C89-clean)', 'ext/implicit-int');
    }
    return { typeSpecs, storage, qualConst, qualVolatile, inline, span: this.spanFrom(start) };
  }

  private parseStructUnion(): A.StructUnionSpec {
    const start = this.advance(); // 'struct' | 'union'
    const su = start.value as 'struct' | 'union';
    let tag: string | undefined;
    if (this.cur().kind === 'id' && !this.isPunct('{')) tag = this.advance().value;
    let fields: A.StructField[] | null = null;
    if (this.matchPunct('{')) {
      fields = [];
      while (!this.isPunct('}') && !this.atEnd()) {
        fields.push(...this.parseStructField());
      }
      this.expectPunct('}');
    }
    return { kind: 'StructUnion', su, tag, fields, span: this.spanFrom(start) };
  }

  private parseStructField(): A.StructField[] {
    const start = this.cur();
    const specifiers = this.parseDeclSpecifiers();
    const out: A.StructField[] = [];
    if (this.matchPunct(';')) {
      // Anonymous struct/union member.
      out.push({ specifiers, declarator: null, bitWidth: null, span: this.spanFrom(start) });
      return out;
    }
    for (;;) {
      let declarator: A.Declarator | null = null;
      if (!this.isPunct(':')) declarator = this.parseDeclarator(false);
      let bitWidth: A.Expr | null = null;
      if (this.matchPunct(':')) bitWidth = this.parseConditional();
      out.push({ specifiers, declarator, bitWidth, span: this.spanFrom(start) });
      if (!this.matchPunct(',')) break;
    }
    this.expectPunct(';');
    return out;
  }

  private parseEnum(): A.EnumSpec {
    const start = this.advance(); // 'enum'
    let tag: string | undefined;
    if (this.cur().kind === 'id' && !this.isPunct('{')) tag = this.advance().value;
    let enumerators: A.Enumerator[] | null = null;
    if (this.matchPunct('{')) {
      enumerators = [];
      while (!this.isPunct('}') && !this.atEnd()) {
        const nameTok = this.advance();
        let value: A.Expr | null = null;
        if (this.matchPunct('=')) value = this.parseConditional();
        enumerators.push({ name: nameTok.value, value, span: this.spanFrom(nameTok) });
        if (!this.matchPunct(',')) break;
      }
      this.expectPunct('}');
    }
    return { kind: 'Enum', tag, enumerators, span: this.spanFrom(start) };
  }

  // -- declarators -----------------------------------------------------------

  private parseDeclarator(abstract: boolean): A.Declarator {
    const ptrs = this.parsePointers();
    let d = this.parseDirectDeclarator(abstract);
    for (const p of ptrs) d = { kind: 'PointerDeclarator', qualConst: p.c, qualVolatile: p.v, inner: d, span: p.span };
    return d;
  }

  private parsePointers(): { c: boolean; v: boolean; span: Span }[] {
    const out: { c: boolean; v: boolean; span: Span }[] = [];
    while (this.isPunct('*')) {
      const star = this.advance();
      let c = false;
      let v = false;
      while (this.cur().kind === 'id' && QUAL.has(this.cur().value)) {
        const q = this.advance().value;
        if (q === 'const') c = true;
        if (q === 'volatile') v = true;
      }
      out.push({ c, v, span: this.spanFrom(star) });
    }
    return out;
  }

  private parseDirectDeclarator(abstract: boolean): A.Declarator {
    const start = this.cur();
    let base: A.Declarator;

    if (this.isPunct('(') && !(abstract && (this.startsDeclSpecifiers(this.peek(1)) || this.isPunct(')', 1)))) {
      // Grouping: ( declarator )
      this.advance();
      base = this.parseDeclarator(abstract);
      this.expectPunct(')');
    } else if (this.cur().kind === 'id' && !this.startsDeclSpecifiers()) {
      base = { kind: 'IdentDeclarator', name: this.advance().value, span: this.spanFrom(start) };
    } else {
      base = { kind: 'IdentDeclarator', span: this.spanFrom(start) };
    }

    // Suffixes: each later suffix wraps as the outer node.
    for (;;) {
      if (this.isPunct('[')) {
        const br = this.advance();
        let size: A.Expr | null = null;
        let vla = false;
        // ignore static / qualifiers inside [] (C99), accept leniently
        while (this.cur().kind === 'id' && (QUAL.has(this.cur().value) || this.cur().value === 'static')) this.advance();
        if (!this.isPunct(']')) {
          size = this.parseAssignment();
          vla = size.kind !== 'IntLit';
        }
        this.expectPunct(']');
        base = { kind: 'ArrayDeclarator', inner: base, size, vla, span: this.spanFrom(br) };
      } else if (this.isPunct('(')) {
        const par = this.advance();
        const { params, variadic, kr, hasProto } = this.parseParams();
        this.expectPunct(')');
        base = { kind: 'FunctionDeclarator', inner: base, params, variadic, kr, hasProto, span: this.spanFrom(par) };
      } else {
        break;
      }
    }
    return base;
  }

  private parseParams(): { params: A.ParamDecl[]; variadic: boolean; kr: boolean; hasProto: boolean } {
    if (this.isPunct(')')) return { params: [], variadic: false, kr: true, hasProto: false };
    // (void) — a prototype with no parameters.
    if (this.isKw('void') && this.isPunct(')', 1)) {
      this.advance();
      return { params: [], variadic: false, kr: false, hasProto: true };
    }
    // Old-style identifier list: identifiers that are not type names.
    if (this.cur().kind === 'id' && !this.startsDeclSpecifiers()) {
      const params: A.ParamDecl[] = [];
      for (;;) {
        const t = this.advance();
        params.push({
          specifiers: { typeSpecs: [], qualConst: false, qualVolatile: false, inline: false, span: t.span },
          declarator: { kind: 'IdentDeclarator', name: t.value, span: t.span },
          span: t.span,
        });
        if (!this.matchPunct(',')) break;
      }
      return { params, variadic: false, kr: true, hasProto: false };
    }
    // Prototype: parameter-type-list.
    const params: A.ParamDecl[] = [];
    let variadic = false;
    for (;;) {
      if (this.isPunct('...')) {
        this.advance();
        variadic = true;
        break;
      }
      const start = this.cur();
      const specifiers = this.parseDeclSpecifiers();
      let declarator: A.Declarator | null = null;
      if (!this.isPunct(',') && !this.isPunct(')')) declarator = this.parseDeclarator(true);
      params.push({ specifiers, declarator, span: this.spanFrom(start) });
      if (!this.matchPunct(',')) break;
    }
    return { params, variadic, kr: false, hasProto: true };
  }

  private parseTypeName(): A.TypeName {
    const start = this.cur();
    const specifiers = this.parseDeclSpecifiers();
    let declarator: A.Declarator | null = null;
    if (!this.isPunct(')')) declarator = this.parseDeclarator(true);
    return { specifiers, declarator, span: this.spanFrom(start) };
  }

  // -- initializers ----------------------------------------------------------

  private parseInitializer(): A.Initializer {
    const start = this.cur();
    if (this.isPunct('{')) {
      this.advance();
      const items: A.InitItem[] = [];
      while (!this.isPunct('}') && !this.atEnd()) {
        const itemStart = this.cur();
        const designators: A.Designator[] = [];
        while (this.isPunct('[') || this.isPunct('.')) {
          if (this.matchPunct('[')) {
            const idx = this.parseConditional();
            this.expectPunct(']');
            designators.push({ kind: 'array', index: idx, span: this.spanFrom(itemStart) });
          } else {
            this.advance(); // '.'
            const name = this.advance().value;
            designators.push({ kind: 'field', name, span: this.spanFrom(itemStart) });
          }
        }
        if (designators.length > 0) this.expectPunct('=');
        const init = this.parseInitializer();
        items.push({ designators, init, span: this.spanFrom(itemStart) });
        if (!this.matchPunct(',')) break;
      }
      this.expectPunct('}');
      return { kind: 'ListInit', items, span: this.spanFrom(start) };
    }
    return { kind: 'ExprInit', expr: this.parseAssignment(), span: this.spanFrom(start) };
  }

  // -- statements ------------------------------------------------------------

  private parseCompound(): A.CompoundStmt {
    const start = this.expectPunct('{');
    this.pushScope();
    const items: A.BlockItem[] = [];
    while (!this.isPunct('}') && !this.atEnd()) {
      try {
        items.push(this.parseBlockItem());
      } catch (e) {
        if (e instanceof CompileError) {
          this.diagnostics.push({ severity: 'error', message: e.message, span: e.span });
          this.synchronize();
        } else throw e;
      }
    }
    this.popScope();
    this.expectPunct('}');
    return { kind: 'CompoundStmt', items, span: this.spanFrom(start) };
  }

  private parseBlockItem(): A.BlockItem {
    // A label is `id :` and is a statement, not a declaration.
    if (this.startsDeclSpecifiers() && !(this.cur().kind === 'id' && this.isPunct(':', 1))) {
      return this.parseDeclaration();
    }
    return this.parseStatement();
  }

  private parseStatement(): A.Stmt {
    const start = this.cur();
    // Labels
    if (this.cur().kind === 'id' && this.isPunct(':', 1) && !this.isTypedefName(this.cur().value)) {
      const label = this.advance().value;
      this.advance(); // ':'
      return { kind: 'LabeledStmt', label, stmt: this.parseStatement(), span: this.spanFrom(start) };
    }
    if (this.matchKw('case')) {
      const value = this.parseConditional();
      this.expectPunct(':');
      return { kind: 'CaseStmt', value, stmt: this.parseStatement(), span: this.spanFrom(start) };
    }
    if (this.matchKw('default')) {
      this.expectPunct(':');
      return { kind: 'DefaultStmt', stmt: this.parseStatement(), span: this.spanFrom(start) };
    }
    if (this.isPunct('{')) return this.parseCompound();
    if (this.matchPunct(';')) return { kind: 'EmptyStmt', span: this.spanFrom(start) };
    if (this.matchKw('if')) return this.parseIf(start);
    if (this.matchKw('while')) return this.parseWhile(start);
    if (this.matchKw('do')) return this.parseDoWhile(start);
    if (this.matchKw('for')) return this.parseFor(start);
    if (this.matchKw('switch')) return this.parseSwitch(start);
    if (this.matchKw('break')) {
      this.expectPunct(';');
      return { kind: 'BreakStmt', span: this.spanFrom(start) };
    }
    if (this.matchKw('continue')) {
      this.expectPunct(';');
      return { kind: 'ContinueStmt', span: this.spanFrom(start) };
    }
    if (this.matchKw('return')) {
      let value: A.Expr | null = null;
      if (!this.isPunct(';')) value = this.parseExpression();
      this.expectPunct(';');
      return { kind: 'ReturnStmt', value, span: this.spanFrom(start) };
    }
    if (this.matchKw('goto')) {
      const label = this.advance().value;
      this.expectPunct(';');
      return { kind: 'GotoStmt', label, span: this.spanFrom(start) };
    }
    const expr = this.parseExpression();
    this.expectPunct(';');
    return { kind: 'ExprStmt', expr, span: this.spanFrom(start) };
  }

  private parseIf(start: Token): A.Stmt {
    this.expectPunct('(');
    const cond = this.parseExpression();
    this.expectPunct(')');
    const then = this.parseStatement();
    let els: A.Stmt | null = null;
    if (this.matchKw('else')) els = this.parseStatement();
    return { kind: 'IfStmt', cond, then, else: els, span: this.spanFrom(start) };
  }

  private parseWhile(start: Token): A.Stmt {
    this.expectPunct('(');
    const cond = this.parseExpression();
    this.expectPunct(')');
    return { kind: 'WhileStmt', cond, body: this.parseStatement(), span: this.spanFrom(start) };
  }

  private parseDoWhile(start: Token): A.Stmt {
    const body = this.parseStatement();
    if (!this.matchKw('while')) throw this.fail("expected 'while' after do-body");
    this.expectPunct('(');
    const cond = this.parseExpression();
    this.expectPunct(')');
    this.expectPunct(';');
    return { kind: 'DoWhileStmt', body, cond, span: this.spanFrom(start) };
  }

  private parseFor(start: Token): A.Stmt {
    this.expectPunct('(');
    this.pushScope();
    let init: A.Declaration | A.Expr | null = null;
    if (this.matchPunct(';')) {
      init = null;
    } else if (this.startsDeclSpecifiers()) {
      init = this.parseDeclaration(); // for-init declaration (friendly extra)
    } else {
      init = this.parseExpression();
      this.expectPunct(';');
    }
    let cond: A.Expr | null = null;
    if (!this.isPunct(';')) cond = this.parseExpression();
    this.expectPunct(';');
    let step: A.Expr | null = null;
    if (!this.isPunct(')')) step = this.parseExpression();
    this.expectPunct(')');
    const body = this.parseStatement();
    this.popScope();
    return { kind: 'ForStmt', init, cond, step, body, span: this.spanFrom(start) };
  }

  private parseSwitch(start: Token): A.Stmt {
    this.expectPunct('(');
    const disc = this.parseExpression();
    this.expectPunct(')');
    return { kind: 'SwitchStmt', disc, body: this.parseStatement(), span: this.spanFrom(start) };
  }

  // -- expressions -----------------------------------------------------------

  private parseExpression(): A.Expr {
    const start = this.cur();
    let e = this.parseAssignment();
    if (this.isPunct(',')) {
      const items = [e];
      while (this.matchPunct(',')) items.push(this.parseAssignment());
      e = { kind: 'CommaExpr', items, span: this.spanFrom(start) };
    }
    return e;
  }

  private parseAssignment(): A.Expr {
    const start = this.cur();
    const left = this.parseConditional();
    const t = this.cur();
    if (t.kind === 'punct' && ASSIGN_OPS.has(t.value)) {
      this.advance();
      const value = this.parseAssignment();
      return { kind: 'AssignExpr', op: t.value, target: left, value, span: this.spanFrom(start) };
    }
    return left;
  }

  private parseConditional(): A.Expr {
    const start = this.cur();
    const cond = this.parseBinary(1);
    if (this.matchPunct('?')) {
      const then = this.parseAssignment();
      this.expectPunct(':');
      const els = this.parseConditional();
      return { kind: 'CondExpr', cond, then, else: els, span: this.spanFrom(start) };
    }
    return cond;
  }

  private parseBinary(minPrec: number): A.Expr {
    const start = this.cur();
    let left = this.parseCast();
    for (;;) {
      const t = this.cur();
      if (t.kind !== 'punct') break;
      const prec = BIN_PREC[t.value];
      if (prec === undefined || prec < minPrec) break;
      this.advance();
      const right = this.parseBinary(prec + 1);
      left = { kind: 'BinaryExpr', op: t.value, left, right, span: this.spanFrom(start) };
    }
    return left;
  }

  private parseCast(): A.Expr {
    const start = this.cur();
    if (this.isPunct('(') && this.startsDeclSpecifiers(this.peek(1))) {
      this.advance(); // '('
      const type = this.parseTypeName();
      this.expectPunct(')');
      const operand = this.parseCast();
      return { kind: 'CastExpr', type, operand, span: this.spanFrom(start) };
    }
    return this.parseUnary();
  }

  private parseUnary(): A.Expr {
    const start = this.cur();
    if (this.isPunct('++') || this.isPunct('--')) {
      const op = this.advance().value as '++' | '--';
      return { kind: 'UnaryExpr', op, operand: this.parseUnary(), prefix: true, span: this.spanFrom(start) };
    }
    const unaryOps = ['&', '*', '+', '-', '~', '!'];
    if (this.cur().kind === 'punct' && unaryOps.includes(this.cur().value)) {
      const op = this.advance().value as A.UnaryExpr['op'];
      return { kind: 'UnaryExpr', op, operand: this.parseCast(), prefix: true, span: this.spanFrom(start) };
    }
    if (this.matchKw('sizeof')) {
      if (this.isPunct('(') && this.startsDeclSpecifiers(this.peek(1))) {
        this.advance();
        const type = this.parseTypeName();
        this.expectPunct(')');
        return { kind: 'SizeofType', type, span: this.spanFrom(start) };
      }
      return { kind: 'SizeofExpr', operand: this.parseUnary(), span: this.spanFrom(start) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): A.Expr {
    const start = this.cur();
    let e = this.parsePrimary();
    for (;;) {
      if (this.matchPunct('[')) {
        const index = this.parseExpression();
        this.expectPunct(']');
        e = { kind: 'IndexExpr', base: e, index, span: this.spanFrom(start) };
      } else if (this.matchPunct('(')) {
        const args: A.Expr[] = [];
        if (!this.isPunct(')')) {
          args.push(this.parseAssignment());
          while (this.matchPunct(',')) args.push(this.parseAssignment());
        }
        this.expectPunct(')');
        e = { kind: 'CallExpr', callee: e, args, span: this.spanFrom(start) };
      } else if (this.matchPunct('.')) {
        const name = this.advance().value;
        e = { kind: 'MemberExpr', base: e, name, arrow: false, span: this.spanFrom(start) };
      } else if (this.matchPunct('->')) {
        const name = this.advance().value;
        e = { kind: 'MemberExpr', base: e, name, arrow: true, span: this.spanFrom(start) };
      } else if (this.isPunct('++') || this.isPunct('--')) {
        const op = this.advance().value as '++' | '--';
        e = { kind: 'UnaryExpr', op, operand: e, prefix: false, span: this.spanFrom(start) };
      } else {
        break;
      }
    }
    return e;
  }

  private parsePrimary(): A.Expr {
    const start = this.cur();
    const t = this.cur();
    if (t.kind === 'ppnum') {
      this.advance();
      if (isFloatLiteral(t.value)) {
        const f = parseFloatLiteral(t.value);
        return { kind: 'FloatLit', value: f.value, type: f.type, raw: t.value, span: this.spanFrom(start) };
      }
      const n = parseIntLiteral(t.value);
      return { kind: 'IntLit', value: n.value, unsigned: n.unsigned, rank: n.rank, raw: t.value, span: this.spanFrom(start) };
    }
    if (t.kind === 'char') {
      this.advance();
      return { kind: 'CharLit', value: parseCharLiteral(t.value), wide: t.value.startsWith('L'), span: this.spanFrom(start) };
    }
    if (t.kind === 'string') {
      const bytes: number[] = [];
      let wide = false;
      while (this.cur().kind === 'string') {
        const s = this.advance();
        if (s.value.startsWith('L')) wide = true;
        bytes.push(...parseStringLiteral(s.value));
      }
      return { kind: 'StringLit', bytes, wide, span: this.spanFrom(start) };
    }
    if (t.kind === 'id') {
      this.advance();
      return { kind: 'Ident', name: t.value, span: this.spanFrom(start) };
    }
    if (this.matchPunct('(')) {
      const e = this.parseExpression();
      this.expectPunct(')');
      return e;
    }
    throw this.fail(`expected an expression but found '${t.value || '<eof>'}'`);
  }

  // -- diagnostics -----------------------------------------------------------

  private warnAt(span: Span, message: string, code?: string): void {
    this.diagnostics.push({ severity: 'warning', message, span, code });
  }
}
