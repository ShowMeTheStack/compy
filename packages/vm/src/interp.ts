import * as A from '@cide/cc';
import * as T from '@cide/cc';
import { SemaResult, SymbolInfo } from '@cide/cc';
import { Memory, Console, Syscalls, Vfs, CFault } from '@cide/runtime';
import { Val, intVal, floatVal, ptrVal, convert, narrow, addrOf, isTruthy, asInt } from './value';

/**
 * The tree-walking C interpreter. It executes the typed AST directly over the
 * segmented Memory: every object (global, local, malloc block, string literal)
 * gets a real address, every access goes through Memory's checks so the
 * valgrind-for-beginners sandbox can catch faults, and libc is provided as
 * native functions. Integer math is exact (bigint), floats are IEEE, and
 * pointer arithmetic scales by the pointee size.
 */

export class CRuntimeError extends Error {
  constructor(message: string, readonly span?: A.Span) {
    super(message);
    this.name = 'CRuntimeError';
  }
}

/** Non-error control used to unwind the JS stack when the program exits. */
export class ProgramExit {
  constructor(readonly code: number) {}
}

type Flow =
  | { k: 'normal' }
  | { k: 'return'; v: Val | null }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'goto'; label: string };

const NORMAL: Flow = { k: 'normal' };

export type NativeFn = (ctx: Interp, args: Val[]) => Val | null;

export interface RunOptions {
  memory?: Memory;
  console?: Console;
  syscalls?: Syscalls;
  vfs?: Vfs;
  natives?: Record<string, NativeFn>;
  argv?: string[];
  maxSteps?: number;
}

export interface RunResult {
  exitCode: number;
  faults: CFault[];
  leaks: { addr: number; size: number }[];
}

interface FuncEntry {
  addr: number;
  name: string;
  def?: A.FunctionDef;
  native?: NativeFn;
  sym?: SymbolInfo;
}

export function run(unit: A.TranslationUnit, sema: SemaResult, opts: RunOptions = {}): RunResult {
  return new Interp(unit, sema, opts).run();
}

export class Interp {
  readonly mem: Memory;
  readonly con: Console;
  readonly sys: Syscalls;
  readonly vfs: Vfs;
  private readonly sema: SemaResult;
  private readonly unit: A.TranslationUnit;
  private readonly natives: Record<string, NativeFn>;
  private readonly maxSteps: number;
  private steps = 0;

  private readonly globalAddr = new Map<number, number>();
  private locals: Map<number, number>[] = [];
  private readonly funcByName = new Map<string, FuncEntry>();
  private readonly funcByAddr = new Map<number, FuncEntry>();
  private readonly stringPool = new Map<string, number>();
  private readonly atexit: number[] = [];
  private nextFuncAddr: number;
  private readonly argv: string[];

  constructor(unit: A.TranslationUnit, sema: SemaResult, opts: RunOptions) {
    this.unit = unit;
    this.sema = sema;
    this.vfs = opts.vfs ?? new Vfs();
    this.con = opts.console ?? new Console();
    this.mem = opts.memory ?? new Memory();
    this.sys = opts.syscalls ?? new Syscalls(this.vfs, this.con);
    this.natives = opts.natives ?? {};
    this.maxSteps = opts.maxSteps ?? 50_000_000;
    this.argv = opts.argv ?? ['program'];
    this.nextFuncAddr = this.mem.segments.text.start + 16;
  }

  // -- setup -----------------------------------------------------------------

  run(): RunResult {
    this.registerFunctions();
    this.allocateGlobals();
    this.initGlobals();
    let exitCode = 0;
    try {
      const main = this.funcByName.get('main');
      if (!main || !main.def) throw new CRuntimeError('no main() function');
      const args = this.mainArgs(main.def);
      const ret = this.callUser(main.def, args);
      exitCode = ret ? Number(narrow(T.INT, ret.i)) : 0;
      this.runAtexit();
    } catch (e) {
      if (e instanceof ProgramExit) {
        exitCode = e.code;
        this.runAtexit();
      } else if (e instanceof CFault) {
        this.con.write('err', `\nRuntime fault: ${e.kind} at 0x${e.addr.toString(16)} — ${e.message}\n`);
        exitCode = 139; // SIGSEGV-ish
      } else if (e instanceof CRuntimeError) {
        this.con.write('err', `\nRuntime error: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
    const leaks = this.mem.leaks().map((b) => ({ addr: b.addr, size: b.size }));
    return { exitCode, faults: this.mem.warnings.slice(), leaks };
  }

  private registerFunctions(): void {
    for (const d of this.unit.decls) {
      if (d.kind === 'FunctionDef') {
        const name = A.declaratorName(d.declarator);
        if (name) this.addFunc({ addr: this.allocFuncAddr(), name, def: d, sym: this.sema.symOf.get(d) });
      }
    }
    for (const [name, native] of Object.entries(this.natives)) {
      if (!this.funcByName.has(name)) this.addFunc({ addr: this.allocFuncAddr(), name, native });
    }
  }

  private allocFuncAddr(): number {
    const a = this.nextFuncAddr;
    this.nextFuncAddr += 16;
    return a;
  }
  private addFunc(e: FuncEntry): void {
    this.funcByName.set(e.name, e);
    this.funcByAddr.set(e.addr, e);
  }

  private allocateGlobals(): void {
    // Link external-linkage globals by name so `extern int x;` and the defining
    // `int x = …;` (possibly in different files) share one object.
    const external = new Map<string, number>();
    for (const sym of this.sema.globals) {
      if (sym.kind !== 'var') continue;
      if (sym.linkage === 'external') {
        const shared = external.get(sym.name);
        if (shared !== undefined) {
          this.globalAddr.set(sym.id, shared);
          continue;
        }
      }
      const size = Math.max(1, T.sizeof(sym.type));
      // Zero-initialized globals go to BSS; initialized ones to DATA.
      const initDecl = this.findInitDecl(sym);
      const addr = initDecl?.init ? this.mem.allocData(new Uint8Array(size)) : this.mem.allocBss(size);
      this.globalAddr.set(sym.id, addr);
      if (sym.linkage === 'external') external.set(sym.name, addr);
    }
  }

  private initGlobals(): void {
    for (const d of this.unit.decls) {
      if (d.kind !== 'Declaration') continue;
      for (const init of d.declarators) {
        const sym = this.sema.symOf.get(init);
        if (!sym || sym.kind !== 'var') continue;
        const addr = this.globalAddr.get(sym.id);
        if (addr === undefined) continue;
        if (init.init) this.initObject(addr, sym.type, init.init);
      }
    }
  }

  private findInitDecl(sym: SymbolInfo): A.InitDeclarator | null {
    for (const [node, s] of this.sema.symOf) {
      if (s === sym && 'declarator' in node && 'init' in node) return node as A.InitDeclarator;
    }
    return null;
  }

  private mainArgs(def: A.FunctionDef): Val[] {
    if (def.declarator.kind !== 'FunctionDeclarator' || def.declarator.params.length === 0) return [];
    // int main(int argc, char **argv)
    const argc = this.argv.length;
    const ptrs: number[] = this.argv.map((s) => this.internCString(s));
    const arrAddr = this.mem.malloc(4 * (argc + 1));
    ptrs.forEach((p, i) => this.mem.writeU32(arrAddr + i * 4, p));
    this.mem.writeU32(arrAddr + argc * 4, 0);
    return [intVal(T.INT, BigInt(argc)), ptrVal(T.pointerTo(T.pointerTo(T.CHAR)), arrAddr)];
  }

  // -- calls -----------------------------------------------------------------

  private callUser(def: A.FunctionDef, args: Val[]): Val | null {
    if (this.locals.length > 6000) throw new CFault('stack-overflow', this.mem.stackTop, 0, 'call depth exceeded');
    const savedTop = this.mem.stackTop;
    const frame = new Map<number, number>();
    this.locals.push(frame);
    try {
      if (def.declarator.kind === 'FunctionDeclarator') {
        const params = def.declarator.params.filter((p) => p.declarator || p.specifiers.typeSpecs.length);
        params.forEach((p, i) => {
          const sym = this.sema.symOf.get(p);
          if (!sym) return;
          const addr = this.mem.pushStack(Math.max(1, T.sizeof(sym.type)));
          frame.set(sym.id, addr);
          const arg = args[i] ?? intVal(T.INT, 0n);
          this.storeVal(addr, sym.type, convert(arg, sym.type));
        });
      }
      const flow = this.execCompound(def.body);
      if (flow.k === 'return') return flow.v;
      return null;
    } finally {
      this.locals.pop();
      this.mem.popStackTo(savedTop);
    }
  }

  private callByAddr(addr: number, args: Val[]): Val | null {
    const e = this.funcByAddr.get(addr);
    if (!e) throw new CFault('segfault', addr, 0, 'call through an invalid function pointer');
    if (e.native) return e.native(this, args);
    if (e.def) return this.callUser(e.def, args);
    return null;
  }

  // -- statements ------------------------------------------------------------

  private execCompound(c: A.CompoundStmt): Flow {
    return this.execItems(c.items);
  }

  private execItems(items: A.BlockItem[]): Flow {
    let i = 0;
    while (i < items.length) {
      const item = items[i]!;
      const flow = item.kind === 'Declaration' ? this.execDecl(item) : this.execStmt(item);
      if (flow.k === 'goto') {
        const target = findLabel(items, flow.label);
        if (target >= 0) {
          i = target;
          continue;
        }
        return flow;
      }
      if (flow.k !== 'normal') return flow;
      i++;
    }
    return NORMAL;
  }

  private execDecl(d: A.Declaration): Flow {
    for (const init of d.declarators) {
      const sym = this.sema.symOf.get(init);
      if (!sym) continue;
      if (sym.kind === 'typedef' || sym.storage === 'extern') continue;
      if (sym.storage === 'static') {
        // Function-local static: allocate once in BSS/DATA, keyed by symbol id.
        if (!this.globalAddr.has(sym.id)) {
          const size = Math.max(1, T.sizeof(sym.type));
          const addr = init.init ? this.mem.allocData(new Uint8Array(size)) : this.mem.allocBss(size);
          this.globalAddr.set(sym.id, addr);
          if (init.init) this.initObject(addr, sym.type, init.init);
        }
        continue;
      }
      const type = this.effectiveType(sym.type, init.init);
      const addr = this.mem.pushStack(Math.max(1, T.sizeof(type)));
      this.frame().set(sym.id, addr);
      if (init.init) this.initObject(addr, type, init.init);
    }
    return NORMAL;
  }

  /** Resolve an unspecified array bound (`int a[]={...}`, `char s[]="hi"`). */
  private effectiveType(type: T.CType, init: A.Initializer | null): T.CType {
    if (type.kind === 'array' && type.length === null && init) {
      if (init.kind === 'ListInit') return T.arrayOf(type.of, init.items.length);
      if (init.kind === 'ExprInit' && init.expr.kind === 'StringLit') {
        return T.arrayOf(type.of, init.expr.bytes.length + 1);
      }
    }
    return type;
  }

  private execStmt(s: A.Stmt): Flow {
    if (++this.steps > this.maxSteps) throw new CRuntimeError('execution step limit exceeded (infinite loop?)');
    switch (s.kind) {
      case 'CompoundStmt':
        return this.execCompound(s);
      case 'DeclStmt':
        return this.execDecl(s.decl);
      case 'ExprStmt':
        if (s.expr) this.eval(s.expr);
        return NORMAL;
      case 'EmptyStmt':
        return NORMAL;
      case 'IfStmt':
        if (isTruthy(this.eval(s.cond))) return this.execStmt(s.then);
        if (s.else) return this.execStmt(s.else);
        return NORMAL;
      case 'WhileStmt':
        while (isTruthy(this.eval(s.cond))) {
          const f = this.execStmt(s.body);
          if (f.k === 'break') break;
          if (f.k === 'return' || f.k === 'goto') return f;
        }
        return NORMAL;
      case 'DoWhileStmt':
        do {
          const f = this.execStmt(s.body);
          if (f.k === 'break') break;
          if (f.k === 'return' || f.k === 'goto') return f;
        } while (isTruthy(this.eval(s.cond)));
        return NORMAL;
      case 'ForStmt':
        return this.execFor(s);
      case 'SwitchStmt':
        return this.execSwitch(s);
      case 'ReturnStmt':
        return { k: 'return', v: s.value ? this.eval(s.value) : null };
      case 'BreakStmt':
        return { k: 'break' };
      case 'ContinueStmt':
        return { k: 'continue' };
      case 'GotoStmt':
        return { k: 'goto', label: s.label };
      case 'LabeledStmt':
        return this.execStmt(s.stmt);
      case 'CaseStmt':
        return this.execStmt(s.stmt);
      case 'DefaultStmt':
        return this.execStmt(s.stmt);
    }
  }

  private execFor(s: A.ForStmt): Flow {
    if (s.init) {
      if ('kind' in s.init && s.init.kind === 'Declaration') this.execDecl(s.init);
      else this.eval(s.init as A.Expr);
    }
    for (;;) {
      if (s.cond && !isTruthy(this.eval(s.cond))) break;
      const f = this.execStmt(s.body);
      if (f.k === 'break') break;
      if (f.k === 'return' || f.k === 'goto') return f;
      // 'continue' falls through to the step
      if (s.step) this.eval(s.step);
    }
    return NORMAL;
  }

  private execSwitch(s: A.SwitchStmt): Flow {
    const disc = Number(asInt(this.eval(s.disc)));
    const body = s.body;
    if (body.kind !== 'CompoundStmt') return NORMAL;
    const items = body.items;
    let start = -1;
    let dflt = -1;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.kind === 'CaseStmt') {
        const v = Number(asInt(this.evalConst(it.value)));
        if (v === disc) {
          start = i;
          break;
        }
      } else if (it.kind === 'DefaultStmt') {
        dflt = i;
      }
    }
    if (start < 0) start = dflt;
    if (start < 0) return NORMAL;
    for (let i = start; i < items.length; i++) {
      const it = items[i]!;
      const f = it.kind === 'Declaration' ? this.execDecl(it) : this.execStmt(it);
      if (f.k === 'break') return NORMAL;
      if (f.k === 'return' || f.k === 'goto' || f.k === 'continue') return f;
    }
    return NORMAL;
  }

  private evalConst(e: A.Expr): Val {
    return this.eval(e);
  }

  // -- scope helpers ---------------------------------------------------------

  private frame(): Map<number, number> {
    return this.locals[this.locals.length - 1]!;
  }

  private addrOfSymbol(sym: SymbolInfo): number | null {
    for (let i = this.locals.length - 1; i >= 0; i--) {
      // only the current frame holds this call's locals
    }
    const local = this.frame()?.get(sym.id);
    if (local !== undefined) return local;
    const g = this.globalAddr.get(sym.id);
    if (g !== undefined) return g;
    return null;
  }

  // ==========================================================================
  // Expression evaluation
  // ==========================================================================

  eval(e: A.Expr): Val {
    switch (e.kind) {
      case 'IntLit':
        return intVal(this.exprType(e), e.value);
      case 'FloatLit':
        return floatVal(this.exprType(e), e.value);
      case 'CharLit':
        return intVal(T.INT, BigInt(e.value));
      case 'StringLit':
        return ptrVal(T.pointerTo(T.CHAR), this.internBytes(e.bytes));
      case 'Ident':
        return this.evalIdent(e);
      case 'IndexExpr':
      case 'MemberExpr':
        return this.loadLValue(e);
      case 'UnaryExpr':
        return this.evalUnary(e);
      case 'BinaryExpr':
        return this.evalBinary(e);
      case 'AssignExpr':
        return this.evalAssign(e);
      case 'CondExpr':
        return isTruthy(this.eval(e.cond)) ? this.eval(e.then) : this.eval(e.else);
      case 'CommaExpr': {
        let v: Val = intVal(T.INT, 0n);
        for (const x of e.items) v = this.eval(x);
        return v;
      }
      case 'CastExpr':
        return convert(this.eval(e.operand), this.exprType(e));
      case 'CallExpr':
        return this.evalCall(e);
      case 'SizeofExpr':
        return intVal(T.ULONG, BigInt(T.sizeof(this.semaType(e.operand))));
      case 'SizeofType':
        return intVal(T.ULONG, BigInt(T.sizeof(this.exprType(e))));
    }
  }

  private evalIdent(e: A.Ident): Val {
    const sym = this.sema.useOf.get(e);
    if (sym && sym.kind === 'enumerator') return intVal(T.INT, BigInt(sym.enumValue ?? 0));
    if (sym && sym.kind === 'func') {
      const fn = this.funcByName.get(sym.name);
      return ptrVal(T.pointerTo(sym.type), fn ? fn.addr : 0);
    }
    // Function name referenced without a declaration in scope.
    if (!sym) {
      const fn = this.funcByName.get(e.name);
      if (fn) return ptrVal(T.pointerTo(T.INT), fn.addr);
      throw new CRuntimeError(`'${e.name}' is not defined`, e.span);
    }
    const addr = this.addrOfSymbol(sym);
    if (addr === null) throw new CRuntimeError(`'${e.name}' has no storage`, e.span);
    return this.loadFrom(addr, sym.type);
  }

  /** Evaluate an lvalue expression to its address and type. */
  private lvalue(e: A.Expr): { addr: number; type: T.CType } {
    switch (e.kind) {
      case 'Ident': {
        const sym = this.sema.useOf.get(e);
        if (!sym) throw new CRuntimeError(`'${e.name}' is not an lvalue`, e.span);
        const addr = this.addrOfSymbol(sym);
        if (addr === null) throw new CRuntimeError(`'${e.name}' has no storage`, e.span);
        return { addr, type: sym.type };
      }
      case 'UnaryExpr':
        if (e.op === '*') {
          const p = this.eval(e.operand);
          return { addr: addrOf(p), type: this.pointeeType(p.type) };
        }
        break;
      case 'IndexExpr': {
        const base = this.eval(e.base);
        const idx = asInt(this.eval(e.index));
        const bt = T.decay(base.type);
        const elem = bt.kind === 'pointer' ? bt.to : T.INT;
        return { addr: addrOf(base) + Number(idx) * Math.max(1, T.sizeof(elem)), type: elem };
      }
      case 'MemberExpr': {
        let baseAddr: number;
        let structType: T.CType;
        if (e.arrow) {
          const p = this.eval(e.base);
          baseAddr = addrOf(p);
          structType = this.pointeeType(p.type);
        } else {
          const lv = this.lvalue(e.base);
          baseAddr = lv.addr;
          structType = lv.type;
        }
        if (structType.kind !== 'struct' && structType.kind !== 'union') {
          throw new CRuntimeError('member access on non-struct', e.span);
        }
        const f = structType.fields.find((x) => x.name === e.name);
        if (!f) throw new CRuntimeError(`no member '${e.name}'`, e.span);
        return { addr: baseAddr + f.offset, type: f.type };
      }
    }
    throw new CRuntimeError('expression is not an lvalue', e.span);
  }

  private loadLValue(e: A.Expr): Val {
    const { addr, type } = this.lvalue(e);
    return this.loadFrom(addr, type);
  }

  /** Load a value of `type` from `addr` (arrays/functions decay to pointers). */
  private loadFrom(addr: number, type: T.CType): Val {
    if (type.kind === 'array') return ptrVal(T.pointerTo(type.of), addr);
    if (type.kind === 'function') return ptrVal(T.pointerTo(type), addr);
    if (type.kind === 'struct' || type.kind === 'union') return { type, i: BigInt(addr >>> 0), f: 0 };
    return this.readMem(addr, type);
  }

  private evalUnary(e: A.UnaryExpr): Val {
    if (e.op === '&') {
      const lv = this.lvalue(e.operand);
      return ptrVal(T.pointerTo(lv.type), lv.addr);
    }
    if (e.op === '*') {
      return this.loadLValue(e);
    }
    if (e.op === '++' || e.op === '--') {
      const lv = this.lvalue(e.operand);
      const old = this.loadFrom(lv.addr, lv.type);
      const delta = e.op === '++' ? 1n : -1n;
      const next = this.addToScalar(old, delta);
      this.storeVal(lv.addr, lv.type, next);
      return e.prefix ? next : old;
    }
    const v = this.eval(e.operand);
    switch (e.op) {
      case '+':
        return v;
      case '-':
        return v.type.kind === 'float' ? floatVal(v.type, -v.f) : intVal(T.promote(v.type), -v.i);
      case '~':
        return intVal(T.promote(v.type), ~v.i);
      case '!':
        return intVal(T.INT, isTruthy(v) ? 0n : 1n);
    }
  }

  private addToScalar(v: Val, delta: bigint): Val {
    if (v.type.kind === 'float') return floatVal(v.type, v.f + Number(delta));
    if (v.type.kind === 'pointer') {
      const step = Math.max(1, T.sizeof(v.type.to));
      return ptrVal(v.type, addrOf(v) + Number(delta) * step);
    }
    return intVal(v.type, v.i + delta);
  }

  private evalBinary(e: A.BinaryExpr): Val {
    if (e.op === '&&') return intVal(T.INT, isTruthy(this.eval(e.left)) && isTruthy(this.eval(e.right)) ? 1n : 0n);
    if (e.op === '||') return intVal(T.INT, isTruthy(this.eval(e.left)) || isTruthy(this.eval(e.right)) ? 1n : 0n);
    const l = this.eval(e.left);
    const r = this.eval(e.right);
    return this.binaryOp(e.op, l, r, e.span);
  }

  private binaryOp(op: string, l: Val, r: Val, span?: A.Span): Val {
    const lt = T.decay(l.type);
    const rt = T.decay(r.type);
    // pointer arithmetic
    if (lt.kind === 'pointer' && (op === '+' || op === '-') && T.isInteger(rt)) {
      const step = Math.max(1, T.sizeof(lt.to));
      const off = Number(asInt(r)) * step * (op === '-' ? -1 : 1);
      return ptrVal(lt, addrOf(l) + off);
    }
    if (rt.kind === 'pointer' && op === '+' && T.isInteger(lt)) {
      const step = Math.max(1, T.sizeof(rt.to));
      return ptrVal(rt, addrOf(r) + Number(asInt(l)) * step);
    }
    if (lt.kind === 'pointer' && rt.kind === 'pointer' && op === '-') {
      const step = Math.max(1, T.sizeof(lt.to));
      return intVal(T.LONG, BigInt(Math.trunc((addrOf(l) - addrOf(r)) / step)));
    }
    // comparisons (work for pointers and arithmetic)
    if (['<', '>', '<=', '>=', '==', '!='].includes(op)) {
      return intVal(T.INT, this.compare(op, l, r, lt, rt) ? 1n : 0n);
    }
    // floating arithmetic
    if (lt.kind === 'float' || rt.kind === 'float') {
      const a = l.type.kind === 'float' ? l.f : Number(l.i);
      const b = r.type.kind === 'float' ? r.f : Number(r.i);
      const res = T.usualArithmetic(lt, rt);
      switch (op) {
        case '+': return floatVal(res, a + b);
        case '-': return floatVal(res, a - b);
        case '*': return floatVal(res, a * b);
        case '/': return floatVal(res, a / b);
      }
    }
    // integer arithmetic in the common type
    const res = T.usualArithmetic(lt, rt);
    const a = narrow(res, l.i);
    const b = narrow(res, r.i);
    switch (op) {
      case '+': return intVal(res, a + b);
      case '-': return intVal(res, a - b);
      case '*': return intVal(res, a * b);
      case '/':
        if (b === 0n) throw new CRuntimeError('division by zero', span);
        return intVal(res, a / b);
      case '%':
        if (b === 0n) throw new CRuntimeError('division by zero', span);
        return intVal(res, a % b);
      case '&': return intVal(res, a & b);
      case '|': return intVal(res, a | b);
      case '^': return intVal(res, a ^ b);
      case '<<': return intVal(T.promote(lt), narrow(T.promote(lt), l.i << (r.i & 63n)));
      case '>>': return intVal(T.promote(lt), narrow(T.promote(lt), l.i >> (r.i & 63n)));
    }
    throw new CRuntimeError(`unsupported operator '${op}'`, span);
  }

  private compare(op: string, l: Val, r: Val, lt: T.CType, rt: T.CType): boolean {
    let a: number | bigint;
    let b: number | bigint;
    if (lt.kind === 'float' || rt.kind === 'float') {
      a = l.type.kind === 'float' ? l.f : Number(l.i);
      b = r.type.kind === 'float' ? r.f : Number(r.i);
    } else if (lt.kind === 'pointer' || rt.kind === 'pointer') {
      a = BigInt(addrOf(l));
      b = BigInt(addrOf(r));
    } else {
      const res = T.usualArithmetic(lt, rt);
      a = narrow(res, l.i);
      b = narrow(res, r.i);
    }
    switch (op) {
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      case '==': return a === b;
      case '!=': return a !== b;
    }
    return false;
  }

  private evalAssign(e: A.AssignExpr): Val {
    const lv = this.lvalue(e.target);
    let value: Val;
    if (e.op === '=') {
      value = this.eval(e.value);
    } else {
      const cur = this.loadFrom(lv.addr, lv.type);
      const rhs = this.eval(e.value);
      value = this.binaryOp(e.op.slice(0, -1), cur, rhs, e.span);
    }
    const stored = convert(value, lv.type);
    this.storeVal(lv.addr, lv.type, stored);
    return stored;
  }

  private evalCall(e: A.CallExpr): Val {
    const callee = this.eval(e.callee);
    const args = e.args.map((a) => this.defaultPromote(this.eval(a)));
    const ret = this.callByAddr(addrOf(callee), args);
    return ret ?? intVal(T.INT, 0n);
  }

  /** Default argument promotions for variadic / prototype-less calls. */
  private defaultPromote(v: Val): Val {
    if (v.type.kind === 'float' && v.type.bytes === 4) return floatVal(T.DOUBLE, v.f);
    if (T.isInteger(v.type) && T.sizeof(v.type) < 4) return intVal(T.INT, v.i);
    return v;
  }

  // -- memory access ---------------------------------------------------------

  private readMem(addr: number, type: T.CType): Val {
    if (type.kind === 'float') return floatVal(type, type.bytes === 4 ? this.mem.readF32(addr) : this.mem.readF64(addr));
    if (type.kind === 'pointer' || type.kind === 'enum') return { type, i: BigInt(this.mem.readU32(addr)), f: 0 };
    if (type.kind === 'bool') return intVal(type, BigInt(this.mem.readU8(addr)));
    if (type.kind === 'int') return intVal(type, this.loadInt(addr, type.bytes, type.signed));
    return intVal(T.INT, this.loadInt(addr, 4, true));
  }

  private loadInt(addr: number, bytes: number, signed: boolean): bigint {
    switch (bytes) {
      case 1: return BigInt(signed ? this.mem.readI8(addr) : this.mem.readU8(addr));
      case 2: return BigInt(signed ? this.mem.readI16(addr) : this.mem.readU16(addr));
      case 4: return BigInt(signed ? this.mem.readI32(addr) : this.mem.readU32(addr));
      case 8: return signed ? this.mem.readI64(addr) : this.mem.readU64(addr);
      default: return 0n;
    }
  }

  storeVal(addr: number, type: T.CType, v: Val): void {
    if (type.kind === 'float') {
      if (type.bytes === 4) this.mem.writeF32(addr, v.f);
      else this.mem.writeF64(addr, v.f);
      return;
    }
    if (type.kind === 'struct' || type.kind === 'union') {
      this.mem.copy(addr, addrOf(v), T.sizeof(type));
      return;
    }
    if (type.kind === 'array') {
      this.mem.copy(addr, addrOf(v), T.sizeof(type));
      return;
    }
    const bytes = type.kind === 'int' ? type.bytes : type.kind === 'bool' ? 1 : 4;
    this.storeInt(addr, bytes, narrow(type, v.i));
  }

  private storeInt(addr: number, bytes: number, i: bigint): void {
    switch (bytes) {
      case 1: this.mem.writeU8(addr, Number(i & 0xffn)); break;
      case 2: this.mem.writeI16(addr, Number(BigInt.asIntN(16, i))); break;
      case 4: this.mem.writeI32(addr, Number(BigInt.asIntN(32, i))); break;
      case 8: this.mem.writeI64(addr, BigInt.asIntN(64, i)); break;
    }
  }

  // -- initialization --------------------------------------------------------

  private initObject(addr: number, type: T.CType, init: A.Initializer): void {
    if (init.kind === 'ExprInit') {
      if (type.kind === 'array' && init.expr.kind === 'StringLit') {
        const bytes = init.expr.bytes;
        for (let k = 0; k < bytes.length; k++) this.mem.writeU8(addr + k, bytes[k]!);
        const len = type.length ?? bytes.length + 1;
        for (let k = bytes.length; k < len; k++) this.mem.writeU8(addr + k, 0);
        return;
      }
      this.storeVal(addr, type, convert(this.eval(init.expr), type));
      return;
    }
    // ListInit
    if (type.kind === 'array') {
      const elem = type.of;
      const esize = Math.max(1, T.sizeof(elem));
      let idx = 0;
      for (const item of init.items) {
        const d = item.designators[0];
        if (d && d.kind === 'array') idx = Number(asInt(this.eval(d.index)));
        this.initObject(addr + idx * esize, elem, item.init);
        idx++;
      }
      return;
    }
    if (type.kind === 'struct' || type.kind === 'union') {
      let fi = 0;
      for (const item of init.items) {
        let field = type.fields[fi];
        const d = item.designators[0];
        if (d && d.kind === 'field') {
          const found = type.fields.findIndex((f) => f.name === d.name);
          if (found >= 0) {
            fi = found;
            field = type.fields[found];
          }
        }
        if (field) this.initObject(addr + field.offset, field.type, item.init);
        fi++;
      }
      return;
    }
    // scalar wrapped in braces
    if (init.items[0]) this.initObject(addr, type, init.items[0].init);
  }

  // -- string interning ------------------------------------------------------

  internCString(s: string): number {
    const bytes = [...new TextEncoder().encode(s), 0];
    return this.internBytes(bytes);
  }

  private internBytes(bytes: number[]): number {
    const key = bytes.join(',');
    const cached = this.stringPool.get(key);
    if (cached !== undefined) return cached;
    const addr = this.mem.allocRodata(new Uint8Array(bytes));
    this.stringPool.set(key, addr);
    return addr;
  }

  // -- helpers exposed to native libc ---------------------------------------

  readCString(addr: number): string {
    if (addr === 0) return '';
    const out: number[] = [];
    for (let i = 0; ; i++) {
      const b = this.mem.readU8(addr + i);
      if (b === 0) break;
      out.push(b);
      if (i > 1 << 20) break;
    }
    return new TextDecoder().decode(new Uint8Array(out));
  }

  malloc(n: number): number {
    return this.mem.malloc(n);
  }

  /** Invoke a function pointer (native or user) — used by qsort/bsearch/atexit. */
  callFunctionPointer(addr: number, args: Val[]): Val | null {
    return this.callByAddr(addr, args);
  }

  exit(code: number): never {
    throw new ProgramExit(code);
  }

  registerAtexit(addr: number): void {
    this.atexit.push(addr);
  }

  private runAtexit(): void {
    for (let i = this.atexit.length - 1; i >= 0; i--) {
      try {
        this.callByAddr(this.atexit[i]!, []);
      } catch {
        /* ignore atexit faults */
      }
    }
  }

  // -- type helpers ----------------------------------------------------------

  private exprType(e: A.Expr): T.CType {
    return this.sema.typeOf.get(e) ?? T.INT;
  }
  private semaType(e: A.Expr): T.CType {
    return this.sema.typeOf.get(e) ?? T.INT;
  }
  private pointeeType(t: T.CType): T.CType {
    const d = T.decay(t);
    return d.kind === 'pointer' ? d.to : T.INT;
  }
}

/** Index of a direct block item that is (or wraps) the target label. */
function findLabel(items: A.BlockItem[], label: string): number {
  for (let i = 0; i < items.length; i++) {
    let s: A.BlockItem | A.Stmt = items[i]!;
    while (s.kind === 'LabeledStmt') {
      if (s.label === label) return i;
      s = s.stmt;
    }
  }
  return -1;
}
