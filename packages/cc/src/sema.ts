import { Span } from './token';
import { Diagnostic } from './diagnostic';
import * as A from './ast';
import * as T from './types';

/**
 * Semantic analysis: turns the syntactic AST into typed, scope-resolved
 * information the interpreter and IDE consume. It builds concrete C types from
 * declaration specifiers + declarators (with ILP32 layout), manages the
 * ordinary and tag namespaces across nested scopes, resolves every identifier
 * use to its declaration (powering Ctrl+click go-to-definition), assigns a
 * result type to every expression, evaluates integer constant expressions for
 * array bounds and enum values, and reports the important C constraint
 * violations plus non-C89 usages.
 */

export type SymKind = 'var' | 'func' | 'typedef' | 'enumerator' | 'param';

export interface SymbolInfo {
  id: number;
  name: string;
  type: T.CType;
  kind: SymKind;
  storage?: A.StorageClass;
  linkage: 'external' | 'internal' | 'none';
  declSpan: Span;
  enumValue?: number;
  isDefinition: boolean;
}

export interface DefLink {
  use: Span;
  decl: Span;
  name: string;
}

export interface SemaResult {
  diagnostics: Diagnostic[];
  /** Result type of each expression node. */
  typeOf: Map<A.Expr, T.CType>;
  /** Declaration each identifier use resolves to. */
  useOf: Map<A.Ident, SymbolInfo>;
  /** Type/symbol of each declared object (by its InitDeclarator/ParamDecl). */
  symOf: Map<A.InitDeclarator | A.ParamDecl | A.FunctionDef, SymbolInfo>;
  /** Go-to-definition links (identifier and typedef-name uses). */
  defs: DefLink[];
  globals: SymbolInfo[];
}

interface Scope {
  parent: Scope | null;
  ordinary: Map<string, SymbolInfo>;
  tags: Map<string, T.CType>;
}

export function analyze(unit: A.TranslationUnit): SemaResult {
  return new Sema().run(unit);
}

class Sema {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly typeOf = new Map<A.Expr, T.CType>();
  private readonly useOf = new Map<A.Ident, SymbolInfo>();
  private readonly symOf = new Map<A.InitDeclarator | A.ParamDecl | A.FunctionDef, SymbolInfo>();
  private readonly defs: DefLink[] = [];
  private readonly globals: SymbolInfo[] = [];
  private scope: Scope = { parent: null, ordinary: new Map(), tags: new Map() };
  private nextSymId = 1;
  private nextTagId = 1;
  private currentReturn: T.CType = T.VOID;

  run(unit: A.TranslationUnit): SemaResult {
    for (const d of unit.decls) {
      if (d.kind === 'FunctionDef') this.functionDef(d);
      else this.declaration(d, true);
    }
    return {
      diagnostics: this.diagnostics,
      typeOf: this.typeOf,
      useOf: this.useOf,
      symOf: this.symOf,
      defs: this.defs,
      globals: this.globals,
    };
  }

  // -- scopes ----------------------------------------------------------------

  private push(): void {
    this.scope = { parent: this.scope, ordinary: new Map(), tags: new Map() };
  }
  private pop(): void {
    if (this.scope.parent) this.scope = this.scope.parent;
  }
  private isGlobal(): boolean {
    return this.scope.parent === null;
  }

  private declare(sym: SymbolInfo): SymbolInfo {
    const existing = this.scope.ordinary.get(sym.name);
    if (existing && existing.kind !== sym.kind && !(existing.kind === 'func' && sym.kind === 'func')) {
      this.error(sym.declSpan, `'${sym.name}' redeclared as a different kind of symbol`);
    }
    this.scope.ordinary.set(sym.name, sym);
    if (this.isGlobal()) this.globals.push(sym);
    return sym;
  }

  private resolve(name: string): SymbolInfo | null {
    let s: Scope | null = this.scope;
    while (s) {
      const found = s.ordinary.get(name);
      if (found) return found;
      s = s.parent;
    }
    return null;
  }

  private resolveTag(name: string): T.CType | null {
    let s: Scope | null = this.scope;
    while (s) {
      const found = s.tags.get(name);
      if (found) return found;
      s = s.parent;
    }
    return null;
  }

  // -- declarations ----------------------------------------------------------

  private declaration(d: A.Declaration, global: boolean): void {
    const isTypedef = d.specifiers.storage === 'typedef';
    const base = this.baseType(d.specifiers);
    for (const initDecl of d.declarators) {
      const type = this.applyDeclarator(base, initDecl.declarator);
      const name = A.declaratorName(initDecl.declarator);
      if (!name) continue;
      if (isTypedef) {
        const sym = this.mkSym(name, type, 'typedef', initDecl.span, d.specifiers.storage);
        this.symOf.set(initDecl, sym);
        this.declare(sym);
        continue;
      }
      const kind: SymKind = type.kind === 'function' ? 'func' : 'var';
      const linkage = this.linkageOf(d.specifiers.storage, kind, global);
      const sym = this.mkSym(name, type, kind, initDecl.span, d.specifiers.storage, linkage);
      sym.isDefinition = kind === 'var' && d.specifiers.storage !== 'extern';
      this.symOf.set(initDecl, sym);
      this.declare(sym);
      if (initDecl.init) this.checkInit(initDecl.init, type);
    }
  }

  private linkageOf(storage: A.StorageClass | undefined, kind: SymKind, global: boolean): SymbolInfo['linkage'] {
    if (storage === 'static') return 'internal';
    if (storage === 'extern') return 'external';
    if (kind === 'func') return 'external';
    return global ? 'external' : 'none';
  }

  private functionDef(fn: A.FunctionDef): void {
    const base = this.baseType(fn.specifiers);
    const type = this.applyDeclarator(base, fn.declarator);
    const name = A.declaratorName(fn.declarator) ?? '<anon>';
    const sym = this.mkSym(name, type, 'func', fn.declarator.span, fn.specifiers.storage, this.linkageOf(fn.specifiers.storage, 'func', true));
    sym.isDefinition = true;
    this.symOf.set(fn, sym);
    this.declare(sym);

    this.push();
    // Bind parameters into the function scope.
    if (fn.declarator.kind === 'FunctionDeclarator') {
      for (const p of fn.declarator.params) {
        const pType = T.decay(this.buildParamType(p));
        const pName = p.declarator ? A.declaratorName(p.declarator) : undefined;
        if (pName) {
          const psym = this.mkSym(pName, pType, 'param', p.span, undefined, 'none');
          psym.isDefinition = true;
          this.symOf.set(p, psym);
          this.declare(psym);
        }
      }
    }
    const prevReturn = this.currentReturn;
    this.currentReturn = type.kind === 'function' ? type.ret : T.INT;
    this.compound(fn.body, false);
    this.currentReturn = prevReturn;
    this.pop();
  }

  private buildParamType(p: A.ParamDecl): T.CType {
    const base = this.baseType(p.specifiers);
    return p.declarator ? this.applyDeclarator(base, p.declarator) : base;
  }

  // -- building types --------------------------------------------------------

  private baseType(specs: A.DeclSpecifiers): T.CType {
    const su = specs.typeSpecs.find((s) => s.kind === 'StructUnion') as A.StructUnionSpec | undefined;
    if (su) return this.structUnionType(su, specs);
    const en = specs.typeSpecs.find((s) => s.kind === 'Enum') as A.EnumSpec | undefined;
    if (en) return this.enumType(en, specs);
    const td = specs.typeSpecs.find((s) => s.kind === 'TypedefName') as A.TypedefNameSpec | undefined;
    if (td) {
      const sym = this.resolve(td.name);
      const t = sym && sym.kind === 'typedef' ? sym.type : T.INT;
      return T.withQual(t, specs.qualConst, specs.qualVolatile);
    }
    return T.withQual(this.basicType(specs), specs.qualConst, specs.qualVolatile);
  }

  private basicType(specs: A.DeclSpecifiers): T.CType {
    const names = specs.typeSpecs.filter((s): s is A.BasicTypeSpec => s.kind === 'BasicType').map((s) => s.name);
    const has = (n: string) => names.includes(n as A.BasicTypeSpec['name']);
    const count = (n: string) => names.filter((x) => x === n).length;
    const unsigned = has('unsigned');
    if (has('void')) return T.VOID;
    if (has('_Bool')) return T.BOOL;
    if (has('double')) return T.DOUBLE;
    if (has('float')) return T.FLOAT;
    if (has('char')) return unsigned ? T.UCHAR : has('signed') ? T.SCHAR : T.CHAR;
    if (has('short')) return unsigned ? T.USHORT : T.SHORT;
    if (count('long') >= 2) return unsigned ? T.ULLONG : T.LLONG;
    if (has('long')) return unsigned ? T.ULONG : T.LONG;
    if (has('int') || has('signed') || unsigned) return unsigned ? T.UINT : T.INT;
    return T.INT; // implicit int
  }

  private structUnionType(spec: A.StructUnionSpec, outer: A.DeclSpecifiers): T.CType {
    // A reference to an existing tag with no body.
    if (spec.fields === null && spec.tag) {
      const existing = this.resolveTag(spec.tag);
      if (existing) return T.withQual(existing, outer.qualConst, outer.qualVolatile);
      // Forward declaration: incomplete type.
      const incomplete: T.CType =
        spec.su === 'struct'
          ? { kind: 'struct', tag: spec.tag, fields: [], size: 0, align: 1, complete: false, id: this.nextTagId++ }
          : { kind: 'union', tag: spec.tag, fields: [], size: 0, align: 1, complete: false, id: this.nextTagId++ };
      this.scope.tags.set(spec.tag, incomplete);
      return T.withQual(incomplete, outer.qualConst, outer.qualVolatile);
    }
    // A definition.
    const members: { name: string; type: T.CType; bitWidth?: number }[] = [];
    for (const f of spec.fields ?? []) {
      const fbase = this.baseType(f.specifiers);
      if (!f.declarator) continue; // anonymous member: skip (limited support)
      const ftype = this.applyDeclarator(fbase, f.declarator);
      const fname = A.declaratorName(f.declarator);
      if (fname) members.push({ name: fname, type: ftype });
    }
    const laid = spec.su === 'struct' ? T.layoutStruct(members) : T.layoutUnion(members);
    const type: T.CType =
      spec.su === 'struct'
        ? { kind: 'struct', tag: spec.tag, fields: laid.fields, size: laid.size, align: laid.align, complete: true, id: this.nextTagId++ }
        : { kind: 'union', tag: spec.tag, fields: laid.fields, size: laid.size, align: laid.align, complete: true, id: this.nextTagId++ };
    if (spec.tag) this.scope.tags.set(spec.tag, type);
    return T.withQual(type, outer.qualConst, outer.qualVolatile);
  }

  private enumType(spec: A.EnumSpec, outer: A.DeclSpecifiers): T.CType {
    const type: T.EnumType = { kind: 'enum', tag: spec.tag, complete: spec.enumerators !== null };
    if (spec.tag) this.scope.tags.set(spec.tag, type);
    let next = 0;
    for (const e of spec.enumerators ?? []) {
      if (e.value) {
        const v = this.evalConstInt(e.value);
        if (v !== null) next = v;
      }
      const sym = this.mkSym(e.name, T.INT, 'enumerator', e.span, undefined, 'none');
      sym.enumValue = next;
      sym.isDefinition = true;
      this.declare(sym);
      next++;
    }
    return T.withQual(type, outer.qualConst, outer.qualVolatile);
  }

  /** Apply a declarator chain to a base type (outer node applied first). */
  private applyDeclarator(base: T.CType, d: A.Declarator | null): T.CType {
    if (!d || d.kind === 'IdentDeclarator') return base;
    if (d.kind === 'PointerDeclarator') {
      return this.applyDeclarator(T.withQual(T.pointerTo(base), d.qualConst, d.qualVolatile), d.inner);
    }
    if (d.kind === 'ArrayDeclarator') {
      let length: number | null = null;
      let vla = false;
      if (d.size) {
        const n = this.evalConstInt(d.size);
        if (n === null) vla = true;
        else length = n;
      }
      return this.applyDeclarator(T.arrayOf(base, length, vla), d.inner);
    }
    // FunctionDeclarator
    const params: T.CType[] = [];
    for (const p of d.params) {
      if (p.declarator === null && p.specifiers.typeSpecs.length === 0) continue; // K&R
      const pt = T.decay(this.buildParamType(p));
      if (pt.kind !== 'void') params.push(pt);
    }
    const fn: T.FunctionType = { kind: 'function', ret: base, params, variadic: d.variadic, hasProto: d.hasProto };
    return this.applyDeclarator(fn, d.inner);
  }

  private mkSym(
    name: string,
    type: T.CType,
    kind: SymKind,
    declSpan: Span,
    storage?: A.StorageClass,
    linkage: SymbolInfo['linkage'] = 'none',
  ): SymbolInfo {
    return { id: this.nextSymId++, name, type, kind, storage, linkage, declSpan, isDefinition: false };
  }

  // -- statements ------------------------------------------------------------

  private compound(c: A.CompoundStmt, ownScope = true): void {
    if (ownScope) this.push();
    for (const item of c.items) {
      if (item.kind === 'Declaration') this.declaration(item, false);
      else this.statement(item);
    }
    if (ownScope) this.pop();
  }

  private statement(s: A.Stmt): void {
    switch (s.kind) {
      case 'CompoundStmt':
        return this.compound(s);
      case 'DeclStmt':
        return this.declaration(s.decl, false);
      case 'ExprStmt':
        if (s.expr) this.expr(s.expr);
        return;
      case 'IfStmt':
        this.expr(s.cond);
        this.statement(s.then);
        if (s.else) this.statement(s.else);
        return;
      case 'WhileStmt':
        this.expr(s.cond);
        return this.statement(s.body);
      case 'DoWhileStmt':
        this.statement(s.body);
        this.expr(s.cond);
        return;
      case 'ForStmt': {
        this.push();
        if (s.init) {
          if ('kind' in s.init && s.init.kind === 'Declaration') this.declaration(s.init, false);
          else this.expr(s.init as A.Expr);
        }
        if (s.cond) this.expr(s.cond);
        if (s.step) this.expr(s.step);
        this.statement(s.body);
        this.pop();
        return;
      }
      case 'SwitchStmt':
        this.expr(s.disc);
        return this.statement(s.body);
      case 'ReturnStmt':
        if (s.value) this.expr(s.value);
        return;
      case 'LabeledStmt':
        return this.statement(s.stmt);
      case 'CaseStmt':
        this.expr(s.value);
        return this.statement(s.stmt);
      case 'DefaultStmt':
        return this.statement(s.stmt);
      case 'BreakStmt':
      case 'ContinueStmt':
      case 'GotoStmt':
      case 'EmptyStmt':
        return;
    }
  }

  // -- expression typing -----------------------------------------------------

  private expr(e: A.Expr): T.CType {
    const t = this.typeExpr(e);
    this.typeOf.set(e, t);
    return t;
  }

  private typeExpr(e: A.Expr): T.CType {
    switch (e.kind) {
      case 'IntLit':
        return e.unsigned ? (e.rank === 'llong' ? T.ULLONG : e.rank === 'long' ? T.ULONG : T.UINT) : e.rank === 'llong' ? T.LLONG : e.rank === 'long' ? T.LONG : T.INT;
      case 'FloatLit':
        return e.type === 'float' ? T.FLOAT : T.DOUBLE;
      case 'CharLit':
        return T.INT; // character constants are int in C
      case 'StringLit':
        return T.arrayOf(T.CHAR, e.bytes.length + 1);
      case 'Ident':
        return this.identType(e);
      case 'CallExpr':
        return this.callType(e);
      case 'IndexExpr': {
        const base = T.decay(this.expr(e.base));
        this.expr(e.index);
        if (base.kind === 'pointer') return base.to;
        this.error(e.span, 'subscripted value is not an array or pointer');
        return T.INT;
      }
      case 'MemberExpr':
        return this.memberType(e);
      case 'UnaryExpr':
        return this.unaryType(e);
      case 'BinaryExpr':
        return this.binaryType(e);
      case 'AssignExpr': {
        const target = this.expr(e.target);
        this.expr(e.value);
        return target;
      }
      case 'CondExpr': {
        this.expr(e.cond);
        const a = T.decay(this.expr(e.then));
        const b = T.decay(this.expr(e.else));
        if (T.isArithmetic(a) && T.isArithmetic(b)) return T.usualArithmetic(a, b);
        return a.kind === 'pointer' ? a : b;
      }
      case 'CommaExpr': {
        let last: T.CType = T.VOID;
        for (const x of e.items) last = this.expr(x);
        return last;
      }
      case 'CastExpr': {
        this.expr(e.operand);
        return this.typeName(e.type);
      }
      case 'SizeofExpr':
        this.expr(e.operand);
        return T.ULONG; // size_t
      case 'SizeofType':
        this.typeName(e.type);
        return T.ULONG;
    }
  }

  private identType(e: A.Ident): T.CType {
    const sym = this.resolve(e.name);
    if (!sym) {
      this.error(e.span, `'${e.name}' undeclared`);
      return T.INT;
    }
    this.useOf.set(e, sym);
    this.defs.push({ use: e.span, decl: sym.declSpan, name: e.name });
    return sym.type;
  }

  private callType(e: A.CallExpr): T.CType {
    let fnType = T.decay(this.expr(e.callee));
    for (const a of e.args) this.expr(a);
    if (fnType.kind === 'pointer' && fnType.to.kind === 'function') return fnType.to.ret;
    if (fnType.kind === 'function') return fnType.ret;
    return T.INT; // implicit function declaration → returns int
  }

  private memberType(e: A.MemberExpr): T.CType {
    let baseType = this.expr(e.base);
    if (e.arrow) {
      const d = T.decay(baseType);
      baseType = d.kind === 'pointer' ? d.to : baseType;
    }
    if (baseType.kind === 'struct' || baseType.kind === 'union') {
      const f = baseType.fields.find((x) => x.name === e.name);
      if (f) return f.type;
      this.error(e.span, `no member named '${e.name}' in ${T.formatType(baseType)}`);
    } else {
      this.error(e.span, `request for member '${e.name}' in something not a structure or union`);
    }
    return T.INT;
  }

  private unaryType(e: A.UnaryExpr): T.CType {
    const operand = this.expr(e.operand);
    switch (e.op) {
      case '&':
        return T.pointerTo(operand);
      case '*': {
        const d = T.decay(operand);
        if (d.kind === 'pointer') return d.to;
        this.error(e.span, 'indirection requires a pointer operand');
        return T.INT;
      }
      case '!':
        return T.INT;
      case '~':
        return T.promote(operand);
      case '+':
      case '-':
        return T.isArithmetic(operand) ? T.promote(operand) : operand;
      case '++':
      case '--':
        return operand;
    }
  }

  private binaryType(e: A.BinaryExpr): T.CType {
    const l = T.decay(this.expr(e.left));
    const r = T.decay(this.expr(e.right));
    switch (e.op) {
      case '+':
        if (l.kind === 'pointer') return l;
        if (r.kind === 'pointer') return r;
        return T.usualArithmetic(l, r);
      case '-':
        if (l.kind === 'pointer' && r.kind === 'pointer') return T.LONG; // ptrdiff_t
        if (l.kind === 'pointer') return l;
        return T.usualArithmetic(l, r);
      case '*':
      case '/':
      case '%':
      case '&':
      case '^':
      case '|':
        return T.usualArithmetic(l, r);
      case '<<':
      case '>>':
        return T.promote(l);
      case '<':
      case '>':
      case '<=':
      case '>=':
      case '==':
      case '!=':
      case '&&':
      case '||':
        return T.INT;
      default:
        return T.INT;
    }
  }

  private typeName(tn: A.TypeName): T.CType {
    const base = this.baseType(tn.specifiers);
    return this.applyDeclarator(base, tn.declarator);
  }

  private checkInit(init: A.Initializer, _target: T.CType): void {
    if (init.kind === 'ExprInit') this.expr(init.expr);
    else for (const item of init.items) this.checkInit(item.init, _target);
  }

  // -- constant expression evaluation (array bounds, enum values) ------------

  private evalConstInt(e: A.Expr): number | null {
    switch (e.kind) {
      case 'IntLit':
        return Number(e.value);
      case 'CharLit':
        return e.value;
      case 'Ident': {
        const sym = this.resolve(e.name);
        if (sym && sym.kind === 'enumerator' && sym.enumValue !== undefined) return sym.enumValue;
        return null;
      }
      case 'UnaryExpr': {
        const v = this.evalConstInt(e.operand);
        if (v === null) return null;
        if (e.op === '-') return -v;
        if (e.op === '+') return v;
        if (e.op === '~') return ~v;
        if (e.op === '!') return v === 0 ? 1 : 0;
        return null;
      }
      case 'BinaryExpr': {
        const a = this.evalConstInt(e.left);
        const b = this.evalConstInt(e.right);
        if (a === null || b === null) return null;
        return applyConstBinary(e.op, a, b);
      }
      case 'CondExpr': {
        const c = this.evalConstInt(e.cond);
        if (c === null) return null;
        return c !== 0 ? this.evalConstInt(e.then) : this.evalConstInt(e.else);
      }
      case 'SizeofType':
        return T.sizeof(this.typeName(e.type));
      case 'SizeofExpr': {
        const t = this.typeExpr(e.operand);
        return T.sizeof(t);
      }
      case 'CastExpr':
        return this.evalConstInt(e.operand);
      default:
        return null;
    }
  }

  // -- diagnostics -----------------------------------------------------------

  private error(span: Span, message: string): void {
    this.diagnostics.push({ severity: 'error', message, span });
  }
}

function applyConstBinary(op: string, a: number, b: number): number | null {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? null : Math.trunc(a / b);
    case '%': return b === 0 ? null : a % b;
    case '<<': return a << b;
    case '>>': return a >> b;
    case '&': return a & b;
    case '|': return a | b;
    case '^': return a ^ b;
    case '<': return a < b ? 1 : 0;
    case '>': return a > b ? 1 : 0;
    case '<=': return a <= b ? 1 : 0;
    case '>=': return a >= b ? 1 : 0;
    case '==': return a === b ? 1 : 0;
    case '!=': return a !== b ? 1 : 0;
    case '&&': return a !== 0 && b !== 0 ? 1 : 0;
    case '||': return a !== 0 || b !== 0 ? 1 : 0;
    default: return null;
  }
}
