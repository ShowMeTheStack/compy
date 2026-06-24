import * as A from '@compy/cc';
import * as T from '@compy/cc';
import { SemaResult, SymbolInfo, Diagnostic, Span } from '@compy/cc';
import {
  Module, Func, Block, Instr, Reg, Value, Const, IrType, Global, Reloc, Sig, BinOp, CmpOp, CastOp,
  constInt, constFloat, isTerminator, bytesOf,
} from './ir';

/**
 * Lowering: the typed, scope-resolved AST becomes IR. This is the "middle"
 * of the compiler — after this point nothing knows about C syntax. The
 * output is deliberately naive (every local is a stack slot; every use is a
 * load) so the optimizer has visible work to do.
 */

export interface LowerResult {
  module: Module;
  diagnostics: Diagnostic[];
}

export function lower(unit: A.TranslationUnit, sema: SemaResult): LowerResult {
  return new Lowerer(unit, sema).run();
}

export function irTypeOf(t: T.CType): IrType {
  switch (t.kind) {
    case 'void': return 'void';
    case 'bool': return 'i8';
    case 'int': return t.bytes === 1 ? 'i8' : t.bytes === 2 ? 'i16' : t.bytes === 4 ? 'i32' : 'i64';
    case 'float': return t.bytes === 4 ? 'f32' : 'f64';
    case 'enum': return 'i32';
    case 'pointer': case 'array': case 'function': case 'struct': case 'union': return 'ptr';
  }
}

function isAggregate(t: T.CType): t is T.StructType | T.UnionType {
  return t.kind === 'struct' || t.kind === 'union';
}

class LowerError extends Error {
  constructor(message: string, readonly span?: Span) {
    super(message);
  }
}

interface LValue {
  addr: Value;
  type: T.CType;
}

interface LoopTargets {
  breakTo: string;
  continueTo: string | null;
}

interface FnCtx {
  fn: Func;
  cur: Block;
  entryAllocas: Instr[];
  localAddr: Map<number, Reg>;
  loops: LoopTargets[];
  labels: Map<string, string>;
  retType: T.CType;
  sret: Reg | null;
  blockCounter: Map<string, number>;
  globalRegs: Map<string, Reg>;
}

type CVal = { k: 'int'; v: bigint } | { k: 'float'; v: number } | { k: 'addr'; reloc: Omit<Reloc, 'offset'> };

class Lowerer {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly module: Module = { functions: [], globals: [], strings: [], externs: [] };
  private readonly stringIds = new Map<string, number>();
  private readonly globalByName = new Map<string, Global>();
  private readonly globalNameOfSym = new Map<number, string>();
  private readonly definedFuncs = new Set<string>();
  private readonly calledNames = new Set<string>();
  private readonly funcTypes = new Map<string, T.FunctionType>();
  private nextReg = 0;
  private ctx!: FnCtx;
  private curLine = 0;

  constructor(
    private readonly unit: A.TranslationUnit,
    private readonly sema: SemaResult,
  ) {}

  run(): LowerResult {
    for (const d of this.unit.decls) {
      if (d.kind === 'FunctionDef') {
        const name = A.declaratorName(d.declarator);
        if (name) {
          this.definedFuncs.add(name);
          const sym = this.sema.symOf.get(d);
          if (sym && sym.type.kind === 'function') this.funcTypes.set(name, sym.type);
        }
      }
    }
    for (const sym of this.sema.globals) if (sym.kind === 'func' && sym.type.kind === 'function' && !this.funcTypes.has(sym.name)) this.funcTypes.set(sym.name, sym.type);
    this.declareGlobals();
    for (const d of this.unit.decls) {
      if (d.kind !== 'FunctionDef') continue;
      try {
        this.lowerFunction(d);
      } catch (e) {
        if (e instanceof LowerError) {
          this.diagnostics.push({ severity: 'error', message: e.message, span: e.span ?? d.span });
        } else throw e;
      }
    }
    for (const n of this.calledNames) if (!this.definedFuncs.has(n)) this.module.externs.push(n);
    return { module: this.module, diagnostics: this.diagnostics };
  }

  // =========================================================================
  // Globals
  // =========================================================================

  private declareGlobals(): void {
    // Which InitDeclarator defines each global (for initializers)?
    const initOf = new Map<number, A.InitDeclarator>();
    for (const d of this.unit.decls) {
      if (d.kind !== 'Declaration') continue;
      for (const id of d.declarators) {
        const sym = this.sema.symOf.get(id);
        if (sym) initOf.set(sym.id, id);
      }
    }
    const externalByName = new Map<string, Global>();
    for (const sym of this.sema.globals) {
      if (sym.kind !== 'var') continue;
      const initDecl = initOf.get(sym.id) ?? null;
      const type = effectiveType(sym.type, initDecl?.init ?? null);
      if (sym.linkage === 'external') {
        const existing = externalByName.get(sym.name);
        if (existing) {
          this.globalNameOfSym.set(sym.id, existing.name);
          if (initDecl?.init && !existing.init) this.fillGlobalInit(existing, type, initDecl.init);
          if (T.sizeof(type) > existing.size) existing.size = T.sizeof(type);
          continue;
        }
      }
      const name = sym.linkage === 'external' ? sym.name : `${sym.name}.${sym.id}`;
      const g = this.newGlobal(name, type, sym.linkage !== 'external', initDecl?.init ?? null);
      this.globalNameOfSym.set(sym.id, name);
      if (sym.linkage === 'external') externalByName.set(sym.name, g);
    }
  }

  private newGlobal(name: string, type: T.CType, internal: boolean, init: A.Initializer | null): Global {
    const g: Global = {
      name,
      size: Math.max(1, T.sizeof(type)),
      align: Math.max(1, T.alignof(type)),
      init: null,
      relocs: [],
      readonly: T.isConst(type) && type.kind !== 'array' ? true : type.kind === 'array' && T.isConst(type.of),
      ctype: T.formatType(type),
      ct: type,
      internal,
    };
    if (init) this.fillGlobalInit(g, type, init);
    this.module.globals.push(g);
    this.globalByName.set(name, g);
    return g;
  }

  private fillGlobalInit(g: Global, type: T.CType, init: A.Initializer): void {
    const bytes = new Uint8Array(g.size);
    const relocs: Reloc[] = [];
    try {
      this.constInit(bytes, relocs, 0, type, init);
    } catch (e) {
      if (e instanceof LowerError) {
        this.diagnostics.push({ severity: 'error', message: `initializer element is not constant: ${e.message}`, span: e.span ?? init.span });
        return;
      }
      throw e;
    }
    g.init = bytes;
    g.relocs = relocs;
  }

  /** Write a constant initializer for `type` into `bytes` at `off`. */
  private constInit(bytes: Uint8Array, relocs: Reloc[], off: number, type: T.CType, init: A.Initializer): void {
    if (init.kind === 'ExprInit') {
      if (type.kind === 'array' && init.expr.kind === 'StringLit') {
        const b = init.expr.bytes;
        const len = type.length ?? b.length + 1;
        for (let k = 0; k < Math.min(b.length, len); k++) bytes[off + k] = b[k]!;
        return;
      }
      if (type.kind === 'array' || isAggregate(type)) {
        // `struct S a = b;` at file scope is not constant unless b is a literal list.
        if (init.expr.kind === 'StringLit') throw new LowerError('string literal initializing non-char array', init.span);
        throw new LowerError('aggregate initializer must be a brace list', init.span);
      }
      const cv = this.constEval(init.expr);
      this.writeConst(bytes, relocs, off, type, cv);
      return;
    }
    if (type.kind === 'array') {
      const esz = Math.max(1, T.sizeof(type.of));
      let idx = 0;
      for (const item of init.items) {
        const d = item.designators[0];
        if (d && d.kind === 'array') idx = Number(this.constInt(d.index));
        if (item.init.kind === 'ExprInit' && item.init.expr.kind === 'StringLit' && type.of.kind === 'array') {
          this.constInit(bytes, relocs, off + idx * esz, type.of, item.init);
        } else this.constInit(bytes, relocs, off + idx * esz, type.of, item.init);
        idx++;
      }
      return;
    }
    if (isAggregate(type)) {
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
        if (field) this.constInit(bytes, relocs, off + field.offset, field.type, item.init);
        fi++;
      }
      return;
    }
    if (init.items[0]) this.constInit(bytes, relocs, off, type, init.items[0].init);
  }

  private writeConst(bytes: Uint8Array, relocs: Reloc[], off: number, type: T.CType, cv: CVal): void {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (type.kind === 'float') {
      const f = cv.k === 'float' ? cv.v : cv.k === 'int' ? Number(cv.v) : 0;
      if (type.bytes === 4) dv.setFloat32(off, f, true);
      else dv.setFloat64(off, f, true);
      return;
    }
    if (cv.k === 'addr') {
      relocs.push({ offset: off, ...cv.reloc });
      return;
    }
    let v = cv.k === 'float' ? BigInt(Math.trunc(cv.v)) : cv.v;
    if (type.kind === 'bool') v = v === 0n ? 0n : 1n;
    const size = type.kind === 'int' ? type.bytes : type.kind === 'bool' ? 1 : 4;
    const u = BigInt.asUintN(size * 8, v);
    for (let k = 0; k < size; k++) bytes[off + k] = Number((u >> BigInt(8 * k)) & 0xffn);
  }

  // -- compile-time constant evaluation ---------------------------------------

  private constInt(e: A.Expr): bigint {
    const cv = this.constEval(e);
    if (cv.k === 'int') return cv.v;
    if (cv.k === 'float') return BigInt(Math.trunc(cv.v));
    throw new LowerError('expected an integer constant expression', e.span);
  }

  private constEval(e: A.Expr): CVal {
    switch (e.kind) {
      case 'IntLit': return { k: 'int', v: e.value };
      case 'CharLit': return { k: 'int', v: BigInt(e.value) };
      case 'FloatLit': return { k: 'float', v: e.value };
      case 'StringLit': return { k: 'addr', reloc: { kind: 'str', ref: this.internString(e.bytes), addend: 0 } };
      case 'Ident': {
        const sym = this.sema.useOf.get(e);
        if (sym?.kind === 'enumerator') return { k: 'int', v: BigInt(sym.enumValue ?? 0) };
        if (sym?.kind === 'func' || (!sym && this.funcTypes.has(e.name))) return { k: 'addr', reloc: { kind: 'func', ref: e.name, addend: 0 } };
        if (sym && (sym.type.kind === 'array' || sym.type.kind === 'function')) {
          const g = this.globalNameOfSym.get(sym.id);
          if (g) return { k: 'addr', reloc: { kind: 'global', ref: g, addend: 0 } };
        }
        throw new LowerError(`'${e.name}' is not a constant`, e.span);
      }
      case 'SizeofType': return { k: 'int', v: BigInt(T.sizeof(this.typeOfTypeName(e.type))) };
      case 'SizeofExpr': return { k: 'int', v: BigInt(T.sizeof(this.exprType(e.operand))) };
      case 'CastExpr': {
        const inner = this.constEval(e.operand);
        const to = this.typeOfTypeName(e.type);
        if (inner.k === 'addr') return inner;
        if (to.kind === 'float') return { k: 'float', v: inner.k === 'float' ? inner.v : Number(inner.v) };
        const v = inner.k === 'float' ? BigInt(Math.trunc(inner.v)) : inner.v;
        if (to.kind === 'int') return { k: 'int', v: narrowInt(v, to.bytes, to.signed) };
        if (to.kind === 'bool') return { k: 'int', v: v === 0n ? 0n : 1n };
        return { k: 'int', v };
      }
      case 'UnaryExpr': {
        if (e.op === '&') return this.constAddr(e.operand);
        const v = this.constEval(e.operand);
        if (v.k === 'addr') throw new LowerError('not a constant', e.span);
        if (e.op === '-') return v.k === 'float' ? { k: 'float', v: -v.v } : { k: 'int', v: -v.v };
        if (e.op === '+') return v;
        if (e.op === '~') return v.k === 'int' ? { k: 'int', v: ~v.v } : v;
        if (e.op === '!') return { k: 'int', v: (v.k === 'int' ? v.v === 0n : v.v === 0) ? 1n : 0n };
        throw new LowerError('not a constant expression', e.span);
      }
      case 'BinaryExpr': {
        const a = this.constEval(e.left);
        const b = this.constEval(e.right);
        if (a.k === 'addr' && b.k === 'int' && (e.op === '+' || e.op === '-')) {
          const pt = this.exprType(e.left);
          const scale = pt.kind === 'pointer' ? Math.max(1, T.sizeof(pt.to)) : pt.kind === 'array' ? Math.max(1, T.sizeof(pt.of)) : 1;
          const delta = Number(b.v) * scale * (e.op === '-' ? -1 : 1);
          return { k: 'addr', reloc: { ...a.reloc, addend: a.reloc.addend + delta } };
        }
        if (a.k === 'addr' || b.k === 'addr') throw new LowerError('not a constant expression', e.span);
        if (a.k === 'float' || b.k === 'float') {
          const x = a.k === 'float' ? a.v : Number(a.v);
          const y = b.k === 'float' ? b.v : Number(b.v);
          switch (e.op) {
            case '+': return { k: 'float', v: x + y };
            case '-': return { k: 'float', v: x - y };
            case '*': return { k: 'float', v: x * y };
            case '/': return { k: 'float', v: x / y };
            case '<': return { k: 'int', v: x < y ? 1n : 0n };
            case '>': return { k: 'int', v: x > y ? 1n : 0n };
            case '<=': return { k: 'int', v: x <= y ? 1n : 0n };
            case '>=': return { k: 'int', v: x >= y ? 1n : 0n };
            case '==': return { k: 'int', v: x === y ? 1n : 0n };
            case '!=': return { k: 'int', v: x !== y ? 1n : 0n };
          }
          throw new LowerError('not a constant expression', e.span);
        }
        const r = constBinary(e.op, a.v, b.v);
        if (r === null) throw new LowerError('not a constant expression', e.span);
        return { k: 'int', v: r };
      }
      case 'CondExpr': {
        const c = this.constEval(e.cond);
        const t = c.k === 'int' ? c.v !== 0n : c.k === 'float' ? c.v !== 0 : true;
        return t ? this.constEval(e.then) : this.constEval(e.else);
      }
      case 'IndexExpr':
      case 'MemberExpr':
        throw new LowerError('not a constant expression', e.span);
      default:
        throw new LowerError('not a constant expression', e.span);
    }
  }

  private constAddr(e: A.Expr): CVal {
    switch (e.kind) {
      case 'Ident': {
        const sym = this.sema.useOf.get(e);
        if (sym?.kind === 'func' || (!sym && this.funcTypes.has(e.name))) return { k: 'addr', reloc: { kind: 'func', ref: e.name, addend: 0 } };
        if (sym) {
          const g = this.globalNameOfSym.get(sym.id);
          if (g) return { k: 'addr', reloc: { kind: 'global', ref: g, addend: 0 } };
        }
        throw new LowerError(`address of '${e.name}' is not a constant`, e.span);
      }
      case 'IndexExpr': {
        const base = this.constEval(e.base);
        const idx = this.constInt(e.index);
        const bt = T.decay(this.exprType(e.base));
        if (base.k !== 'addr' || bt.kind !== 'pointer') throw new LowerError('not a constant address', e.span);
        return { k: 'addr', reloc: { ...base.reloc, addend: base.reloc.addend + Number(idx) * Math.max(1, T.sizeof(bt.to)) } };
      }
      case 'MemberExpr': {
        const base = e.arrow ? this.constEval(e.base) : this.constAddr(e.base);
        let st = this.exprType(e.base);
        if (e.arrow) {
          const d = T.decay(st);
          st = d.kind === 'pointer' ? d.to : st;
        }
        if (base.k !== 'addr' || !isAggregate(st)) throw new LowerError('not a constant address', e.span);
        const f = st.fields.find((x) => x.name === e.name);
        if (!f) throw new LowerError('no such member', e.span);
        return { k: 'addr', reloc: { ...base.reloc, addend: base.reloc.addend + f.offset } };
      }
      case 'UnaryExpr':
        if (e.op === '*') return this.constEval(e.operand);
        break;
      case 'StringLit':
        return this.constEval(e);
    }
    throw new LowerError('not a constant address', e.span);
  }

  // =========================================================================
  // Functions
  // =========================================================================

  private lowerFunction(def: A.FunctionDef): void {
    const name = A.declaratorName(def.declarator) ?? '<anon>';
    const sym = this.sema.symOf.get(def);
    const ftype = sym && sym.type.kind === 'function' ? sym.type : null;
    const retType = ftype ? ftype.ret : T.INT;
    const sret = isAggregate(retType);
    this.nextReg = 0;

    const fn: Func = {
      name,
      params: [],
      ret: sret ? 'void' : irTypeOf(retType),
      variadic: ftype?.variadic ?? false,
      blocks: [],
      csig: `${T.formatType(retType)} ${name}(${ftype ? ftype.params.map(T.formatType).join(', ') : ''})`,
      paramNames: [],
      sret,
      line: def.declarator.span.start.line,
    };
    const entry: Block = { name: 'entry', instrs: [] };
    fn.blocks.push(entry);
    this.ctx = {
      fn,
      cur: entry,
      entryAllocas: [],
      localAddr: new Map(),
      loops: [],
      labels: new Map(),
      retType,
      sret: null,
      blockCounter: new Map(),
      globalRegs: new Map(),
    };
    this.curLine = fn.line ?? 0;

    if (sret) {
      const r = this.newReg('ptr', 'sret');
      fn.params.push(r);
      fn.paramNames.push('<sret>');
      this.ctx.sret = r;
    }
    // Parameters: each gets a stack slot (so mem2reg has work to do), except
    // aggregates which arrive as a pointer to a caller-made copy.
    const fdecl = A.functionDeclaratorOf(def.declarator);
    if (fdecl) {
      const params = fdecl.params.filter((p) => p.declarator || p.specifiers.typeSpecs.length);
      for (const p of params) {
        const psym = this.sema.symOf.get(p);
        if (!psym) continue;
        const r = this.newReg(irTypeOf(psym.type), psym.name);
        fn.params.push(r);
        fn.paramNames.push(psym.name);
        if (isAggregate(psym.type)) {
          this.ctx.localAddr.set(psym.id, r);
        } else {
          const slot = this.alloca(psym.type, psym.name);
          this.ctx.localAddr.set(psym.id, slot);
          this.emit({ op: 'store', addr: slot, val: r });
        }
      }
    }
    // Pre-create blocks for labels so forward gotos resolve.
    collectLabels(def.body, (label) => {
      if (!this.ctx.labels.has(label)) this.ctx.labels.set(label, this.freshBlockName('label.' + label));
    });

    this.lowerCompound(def.body);
    if (!this.terminated()) {
      // Falling off the end: main returns 0; others return an unspecified value.
      if (fn.ret === 'void') this.emit({ op: 'ret' });
      else this.emit({ op: 'ret', val: zeroOf(fn.ret) });
    }
    // Hoist static allocas to the top of the entry block.
    entry.instrs.unshift(...this.ctx.entryAllocas);
    // Drop empty unreachable blocks created after terminators.
    fn.blocks = fn.blocks.filter((b) => b === entry || b.instrs.length > 0);
    for (const b of fn.blocks) if (!isTerminator(b.instrs[b.instrs.length - 1]!)) b.instrs.push({ op: 'unreachable' });
    this.module.functions.push(fn);
  }

  // -- emission helpers --------------------------------------------------------

  private newReg(type: IrType, name?: string): Reg {
    return { kind: 'reg', id: this.nextReg++, type, name };
  }
  private emit<I extends Instr>(i: I): I {
    if (i.line === undefined && this.curLine) i.line = this.curLine;
    this.ctx.cur.instrs.push(i);
    return i;
  }
  private terminated(): boolean {
    const last = this.ctx.cur.instrs[this.ctx.cur.instrs.length - 1];
    return !!last && isTerminator(last);
  }
  private freshBlockName(base: string): string {
    const n = (this.ctx.blockCounter.get(base) ?? 0) + 1;
    this.ctx.blockCounter.set(base, n);
    return n === 1 ? base : `${base}.${n}`;
  }
  private newBlock(base: string): Block {
    const b: Block = { name: this.freshBlockName(base), instrs: [] };
    this.ctx.fn.blocks.push(b);
    return b;
  }
  private newBlockNamed(name: string): Block {
    const b: Block = { name, instrs: [] };
    this.ctx.fn.blocks.push(b);
    return b;
  }
  /** Branch to `b` (if the current block is open) and make it current. */
  private switchTo(b: Block): void {
    if (!this.terminated()) this.emit({ op: 'br', target: b.name });
    this.ctx.cur = b;
  }
  private br(target: string): void {
    if (!this.terminated()) this.emit({ op: 'br', target });
  }
  private alloca(type: T.CType, name: string): Reg {
    const r = this.newReg('ptr', name + '.addr');
    const size = Math.max(1, T.sizeof(type));
    this.ctx.entryAllocas.push({ op: 'alloca', dst: r, size: constInt('i32', size), align: Math.max(1, T.alignof(type)), name, ctype: T.formatType(type), ct: type, line: this.curLine });
    return r;
  }
  private bin(opc: BinOp, type: IrType, a: Value, b: Value): Reg {
    const dst = this.newReg(type);
    this.emit({ op: 'bin', dst, opc, a, b });
    return dst;
  }
  private cmp(opc: CmpOp, a: Value, b: Value): Reg {
    const dst = this.newReg('i1');
    this.emit({ op: 'cmp', dst, opc, a, b });
    return dst;
  }
  private cast(opc: CastOp, src: Value, to: IrType): Value {
    if (src.kind === 'const') {
      const folded = foldCast(opc, src, to);
      if (folded) return folded;
    }
    const dst = this.newReg(to);
    this.emit({ op: 'cast', dst, opc, src });
    return dst;
  }
  private load(addr: Value, type: IrType): Reg {
    const dst = this.newReg(type);
    this.emit({ op: 'load', dst, addr });
    return dst;
  }
  private ptradd(base: Value, index: Value, scale: number): Value {
    if (index.kind === 'const' && index.i === 0n) return base;
    const dst = this.newReg('ptr');
    this.emit({ op: 'ptradd', dst, base, index, scale });
    return dst;
  }
  private globalAddr(name: string): Reg {
    const dst = this.newReg('ptr', name);
    this.emit({ op: 'global', dst, name });
    return dst;
  }
  private internString(bytes: number[]): number {
    const key = bytes.join(',');
    const cached = this.stringIds.get(key);
    if (cached !== undefined) return cached;
    const id = this.module.strings.length;
    this.module.strings.push(new Uint8Array([...bytes, 0]));
    this.stringIds.set(key, id);
    return id;
  }
  private strAddr(bytes: number[]): Reg {
    const dst = this.newReg('ptr');
    this.emit({ op: 'str', dst, id: this.internString(bytes) });
    return dst;
  }

  // =========================================================================
  // Statements
  // =========================================================================

  private lowerCompound(c: A.CompoundStmt): void {
    for (const item of c.items) {
      if (item.kind === 'Declaration') this.lowerDecl(item);
      else this.lowerStmt(item);
    }
  }

  private lowerDecl(d: A.Declaration): void {
    this.curLine = d.span.start.line;
    for (const init of d.declarators) {
      const sym = this.sema.symOf.get(init);
      if (!sym || sym.kind === 'typedef' || sym.storage === 'extern' || sym.kind === 'func') continue;
      if (sym.storage === 'static') {
        const name = `${this.ctx.fn.name}.${sym.name}.${sym.id}`;
        if (!this.globalByName.has(name)) {
          this.newGlobal(name, effectiveType(sym.type, init.init), true, init.init);
          this.globalNameOfSym.set(sym.id, name);
        }
        continue;
      }
      const type = effectiveType(sym.type, init.init);
      let slot: Reg;
      if (type.kind === 'array' && type.vla) {
        // Variable-length array: dynamic alloca at the point of declaration.
        const n = this.vlaLength(init.declarator);
        const size = this.bin('mul', 'i32', n, constInt('i32', Math.max(1, T.sizeof(type.of))));
        slot = this.newReg('ptr', sym.name + '.addr');
        this.emit({ op: 'alloca', dst: slot, size, align: T.alignof(type.of), name: sym.name, ctype: T.formatType(type), ct: type });
      } else {
        slot = this.alloca(type, sym.name);
      }
      this.ctx.localAddr.set(sym.id, slot);
      if (init.init) this.initLocal(slot, type, init.init);
    }
  }

  private vlaLength(d: A.Declarator): Value {
    let cur: A.Declarator | null = d;
    while (cur && cur.kind !== 'ArrayDeclarator') cur = cur.kind === 'IdentDeclarator' ? null : cur.inner;
    if (!cur || cur.kind !== 'ArrayDeclarator' || !cur.size) return constInt('i32', 0);
    return this.toType(this.rvalue(cur.size), this.exprType(cur.size), T.INT);
  }

  /** Emit stores for a local initializer. */
  private initLocal(addr: Value, type: T.CType, init: A.Initializer): void {
    if (init.kind === 'ExprInit') {
      if (type.kind === 'array' && init.expr.kind === 'StringLit') {
        const b = init.expr.bytes;
        const len = type.length ?? b.length + 1;
        const src = this.strAddr(b);
        const n = Math.min(b.length + 1, len);
        this.emit({ op: 'memcpy', dst: addr, src, len: constInt('i32', n) });
        if (len > n) this.emit({ op: 'memset', dst: this.ptradd(addr, constInt('i32', n), 1), byte: constInt('i8', 0), len: constInt('i32', len - n) });
        return;
      }
      if (isAggregate(type)) {
        const src = this.rvalue(init.expr);
        this.emit({ op: 'memcpy', dst: addr, src, len: constInt('i32', T.sizeof(type)) });
        return;
      }
      const v = this.toType(this.rvalue(init.expr), this.exprType(init.expr), type);
      this.emit({ op: 'store', addr, val: v });
      return;
    }
    // Brace list: zero the whole object, then store the listed elements.
    if (type.kind === 'array' || isAggregate(type)) {
      this.emit({ op: 'memset', dst: addr, byte: constInt('i8', 0), len: constInt('i32', Math.max(1, T.sizeof(type))) });
      this.initListInto(addr, type, init);
      return;
    }
    if (init.items[0]) this.initLocal(addr, type, init.items[0].init);
  }

  private initListInto(addr: Value, type: T.CType, init: A.ListInit): void {
    if (type.kind === 'array') {
      const esz = Math.max(1, T.sizeof(type.of));
      let idx = 0;
      for (const item of init.items) {
        const d = item.designators[0];
        if (d && d.kind === 'array') idx = Number(this.constInt(d.index));
        const ea = this.ptradd(addr, constInt('i32', idx * esz), 1);
        this.initElement(ea, type.of, item.init);
        idx++;
      }
      return;
    }
    if (isAggregate(type)) {
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
        if (field) this.initElement(this.ptradd(addr, constInt('i32', field.offset), 1), field.type, item.init);
        fi++;
      }
    }
  }

  /** Element of an already-zeroed aggregate (no extra memset needed). */
  private initElement(addr: Value, type: T.CType, init: A.Initializer): void {
    if (init.kind === 'ListInit') {
      if (type.kind === 'array' || isAggregate(type)) this.initListInto(addr, type, init);
      else if (init.items[0]) this.initElement(addr, type, init.items[0].init);
      return;
    }
    if (type.kind === 'array' && init.expr.kind === 'StringLit') {
      const b = init.expr.bytes;
      const len = type.length ?? b.length + 1;
      this.emit({ op: 'memcpy', dst: addr, src: this.strAddr(b), len: constInt('i32', Math.min(b.length + 1, len)) });
      return;
    }
    if (isAggregate(type)) {
      this.emit({ op: 'memcpy', dst: addr, src: this.rvalue(init.expr), len: constInt('i32', T.sizeof(type)) });
      return;
    }
    this.emit({ op: 'store', addr, val: this.toType(this.rvalue(init.expr), this.exprType(init.expr), type) });
  }

  private lowerStmt(s: A.Stmt): void {
    if (s.kind !== 'CompoundStmt') this.curLine = s.span.start.line;
    switch (s.kind) {
      case 'CompoundStmt':
        return this.lowerCompound(s);
      case 'DeclStmt':
        return this.lowerDecl(s.decl);
      case 'ExprStmt':
        if (s.expr) this.rvalue(s.expr);
        return;
      case 'EmptyStmt':
        return;
      case 'IfStmt': {
        const thenB = this.newBlock('if.then');
        const elseB = s.else ? this.newBlock('if.else') : null;
        const endB = this.newBlock('if.end');
        this.condBranch(s.cond, thenB.name, elseB ? elseB.name : endB.name);
        this.ctx.cur = thenB;
        this.lowerStmt(s.then);
        this.br(endB.name);
        if (elseB && s.else) {
          this.ctx.cur = elseB;
          this.lowerStmt(s.else);
          this.br(endB.name);
        }
        this.ctx.cur = endB;
        return;
      }
      case 'WhileStmt': {
        const condB = this.newBlock('while.cond');
        const bodyB = this.newBlock('while.body');
        const endB = this.newBlock('while.end');
        this.switchTo(condB);
        this.condBranch(s.cond, bodyB.name, endB.name);
        this.ctx.cur = bodyB;
        this.ctx.loops.push({ breakTo: endB.name, continueTo: condB.name });
        this.lowerStmt(s.body);
        this.ctx.loops.pop();
        this.br(condB.name);
        this.ctx.cur = endB;
        return;
      }
      case 'DoWhileStmt': {
        const bodyB = this.newBlock('do.body');
        const condB = this.newBlock('do.cond');
        const endB = this.newBlock('do.end');
        this.switchTo(bodyB);
        this.ctx.loops.push({ breakTo: endB.name, continueTo: condB.name });
        this.lowerStmt(s.body);
        this.ctx.loops.pop();
        this.switchTo(condB);
        this.curLine = s.cond.span.start.line;
        this.condBranch(s.cond, bodyB.name, endB.name);
        this.ctx.cur = endB;
        return;
      }
      case 'ForStmt': {
        if (s.init) {
          if ('kind' in s.init && s.init.kind === 'Declaration') this.lowerDecl(s.init);
          else this.rvalue(s.init as A.Expr);
        }
        const condB = this.newBlock('for.cond');
        const bodyB = this.newBlock('for.body');
        const stepB = s.step ? this.newBlock('for.step') : null;
        const endB = this.newBlock('for.end');
        this.switchTo(condB);
        if (s.cond) this.condBranch(s.cond, bodyB.name, endB.name);
        else this.emit({ op: 'br', target: bodyB.name });
        this.ctx.cur = bodyB;
        this.ctx.loops.push({ breakTo: endB.name, continueTo: stepB ? stepB.name : condB.name });
        this.lowerStmt(s.body);
        this.ctx.loops.pop();
        if (stepB && s.step) {
          this.switchTo(stepB);
          this.curLine = s.step.span.start.line;
          this.rvalue(s.step);
        }
        this.br(condB.name);
        this.ctx.cur = endB;
        return;
      }
      case 'SwitchStmt':
        return this.lowerSwitch(s);
      case 'ReturnStmt': {
        if (this.ctx.sret) {
          if (s.value) {
            const src = this.rvalue(s.value);
            this.emit({ op: 'memcpy', dst: this.ctx.sret, src, len: constInt('i32', T.sizeof(this.ctx.retType)) });
          }
          this.emit({ op: 'ret' });
        } else if (s.value && this.ctx.fn.ret !== 'void') {
          const v = this.toType(this.rvalue(s.value), this.exprType(s.value), this.ctx.retType);
          this.emit({ op: 'ret', val: v });
        } else {
          if (s.value) this.rvalue(s.value);
          if (this.ctx.fn.ret === 'void') this.emit({ op: 'ret' });
          else this.emit({ op: 'ret', val: zeroOf(this.ctx.fn.ret) });
        }
        this.ctx.cur = this.newBlock('after.ret');
        return;
      }
      case 'BreakStmt': {
        const top = this.ctx.loops[this.ctx.loops.length - 1];
        if (top) this.emit({ op: 'br', target: top.breakTo });
        this.ctx.cur = this.newBlock('after.break');
        return;
      }
      case 'ContinueStmt': {
        for (let i = this.ctx.loops.length - 1; i >= 0; i--) {
          const t = this.ctx.loops[i]!;
          if (t.continueTo) {
            this.emit({ op: 'br', target: t.continueTo });
            break;
          }
        }
        this.ctx.cur = this.newBlock('after.continue');
        return;
      }
      case 'GotoStmt': {
        const target = this.ctx.labels.get(s.label);
        if (!target) throw new LowerError(`label '${s.label}' used but not defined`, s.span);
        this.emit({ op: 'br', target });
        this.ctx.cur = this.newBlock('after.goto');
        return;
      }
      case 'LabeledStmt': {
        const name = this.ctx.labels.get(s.label)!;
        const b = this.newBlockNamed(name);
        this.switchTo(b);
        return this.lowerStmt(s.stmt);
      }
      case 'CaseStmt':
      case 'DefaultStmt':
        // Only meaningful inside a switch body; handled by lowerSwitch.
        return this.lowerStmt(s.stmt);
    }
  }

  private lowerSwitch(s: A.SwitchStmt): void {
    const discT = T.promote(T.decay(this.exprType(s.disc)));
    const disc = this.toType(this.rvalue(s.disc), this.exprType(s.disc), discT);
    const endB = this.newBlock('switch.end');
    const body = s.body;
    const items: A.BlockItem[] = body.kind === 'CompoundStmt' ? body.items : [body];

    // First pass: find the case labels and give each a block.
    const cases: { value: bigint; target: string }[] = [];
    let defaultTarget: string | null = null;
    const blockFor = new Map<A.Stmt, Block>();
    for (const item of items) {
      let node: A.BlockItem = item;
      for (;;) {
        if (node.kind === 'CaseStmt') {
          const b = this.newBlock('switch.case');
          cases.push({ value: BigInt.asIntN(32, this.constInt(node.value)), target: b.name });
          blockFor.set(node, b);
          node = node.stmt;
        } else if (node.kind === 'DefaultStmt') {
          const b = this.newBlock('switch.default');
          defaultTarget = b.name;
          blockFor.set(node, b);
          node = node.stmt;
        } else if (node.kind === 'LabeledStmt') {
          node = node.stmt;
        } else break;
      }
    }
    this.emit({ op: 'switch', val: disc, cases, default: defaultTarget ?? endB.name });
    this.ctx.cur = this.newBlock('switch.dead');
    this.ctx.loops.push({ breakTo: endB.name, continueTo: null });
    for (const item of items) {
      if (item.kind === 'Declaration') {
        this.lowerDecl(item);
        continue;
      }
      let node: A.Stmt = item;
      for (;;) {
        const b = blockFor.get(node);
        if (b) {
          this.switchTo(b);
          node = (node as A.CaseStmt | A.DefaultStmt).stmt;
        } else if (node.kind === 'LabeledStmt') {
          const lb = this.newBlockNamed(this.ctx.labels.get(node.label)!);
          this.switchTo(lb);
          node = node.stmt;
        } else break;
      }
      this.lowerStmt(node);
    }
    this.ctx.loops.pop();
    this.switchTo(endB);
  }

  /** Lower a condition straight into a conditional branch. */
  private condBranch(cond: A.Expr, thenB: string, elseB: string): void {
    this.curLine = cond.span.start.line;
    const c = this.truth(cond);
    this.emit({ op: 'condbr', cond: c, then: thenB, else: elseB });
  }

  /** The i1 truth value of a C expression (short-circuit aware). */
  private truth(e: A.Expr): Value {
    if (e.kind === 'UnaryExpr' && e.op === '!') {
      const inner = this.truth(e.operand);
      return this.cmp('eq', inner, constInt('i1', 0));
    }
    if (e.kind === 'BinaryExpr' && (e.op === '&&' || e.op === '||')) {
      const isAnd = e.op === '&&';
      const rhsB = this.newBlock(isAnd ? 'land.rhs' : 'lor.rhs');
      const endB = this.newBlock(isAnd ? 'land.end' : 'lor.end');
      const l = this.truth(e.left);
      const lBlock = this.ctx.cur.name;
      this.emit(isAnd ? { op: 'condbr', cond: l, then: rhsB.name, else: endB.name } : { op: 'condbr', cond: l, then: endB.name, else: rhsB.name });
      this.ctx.cur = rhsB;
      const r = this.truth(e.right);
      const rBlock = this.ctx.cur.name;
      this.emit({ op: 'br', target: endB.name });
      this.ctx.cur = endB;
      const dst = this.newReg('i1');
      this.emit({ op: 'phi', dst, incoming: [{ value: constInt('i1', isAnd ? 0 : 1), block: lBlock }, { value: r, block: rBlock }] });
      return dst;
    }
    if (e.kind === 'BinaryExpr' && ['<', '>', '<=', '>=', '==', '!='].includes(e.op)) {
      return this.compare(e);
    }
    const v = this.rvalue(e);
    const t = T.decay(this.exprType(e));
    if (t.kind === 'float') return this.cmp('one', v, constFloat(v.type, 0));
    if (v.type === 'i1') return v;
    return this.cmp('ne', v, constInt(v.type, 0));
  }

  // =========================================================================
  // Expressions
  // =========================================================================

  private exprType(e: A.Expr): T.CType {
    return this.sema.typeOf.get(e) ?? T.INT;
  }

  private typeOfTypeName(tn: A.TypeName): T.CType {
    // sema typed the cast expression; for sizeof(type) we re-derive via a cast's result when possible.
    // Fallback: build from the specifiers (basic types / typedefs via sema are not reachable here),
    // so we look for a cached type on any CastExpr/SizeofType using this TypeName.
    for (const [expr, t] of this.sema.typeOf) {
      if (expr.kind === 'CastExpr' && expr.type === tn) return t;
    }
    for (const [expr] of this.sema.typeOf) {
      if (expr.kind === 'SizeofType' && expr.type === tn) {
        // sema evaluates sizeof(type) to ULONG; recover the type by re-walking the specifiers.
        break;
      }
    }
    return typeFromTypeName(tn, this.sema);
  }

  /** Convert an IR value of C type `from` to C type `to`, emitting casts as needed. */
  private toType(v: Value, fromC: T.CType, toC: T.CType): Value {
    const from = T.decay(fromC);
    const to = T.decay(toC);
    if (isAggregate(to) || to.kind === 'void') return v;
    const ft = v.type;
    const tt = irTypeOf(to);
    if (to.kind === 'bool') {
      if (ft === 'i1') return this.cast('zext', v, 'i8');
      const c = from.kind === 'float' ? this.cmp('one', v, constFloat(ft, 0)) : this.cmp('ne', v, constInt(ft, 0));
      return this.cast('zext', c, 'i8');
    }
    if (to.kind === 'float') {
      if (from.kind === 'float') {
        if (ft === tt) return v;
        return this.cast(bytesOf(tt) > bytesOf(ft) ? 'fpext' : 'fptrunc', v, tt);
      }
      return this.cast(T.isSignedInt(from) && ft !== 'i1' ? 'sitofp' : 'uitofp', v, tt);
    }
    // integer / enum / pointer target
    if (from.kind === 'float') {
      const iv = this.cast(T.isSignedInt(to) || to.kind === 'pointer' ? 'fptosi' : 'fptoui', v, tt === 'ptr' ? 'i32' : tt);
      return tt === 'ptr' ? this.cast('inttoptr', iv, 'ptr') : iv;
    }
    if (tt === 'ptr') {
      if (ft === 'ptr') return v;
      const w = this.resizeInt(v, from, 'i32');
      return this.cast('inttoptr', w, 'ptr');
    }
    if (ft === 'ptr') {
      const i = this.cast('ptrtoint', v, 'i32');
      return this.resizeInt(i, T.UINT, tt);
    }
    return this.resizeInt(v, from, tt);
  }

  private resizeInt(v: Value, from: T.CType, tt: IrType): Value {
    const ft = v.type;
    if (ft === tt) return v;
    const fb = bytesOf(ft);
    const tb = bytesOf(tt);
    if (ft === 'i1') return this.cast('zext', v, tt);
    if (tb < fb) return this.cast('trunc', v, tt);
    return this.cast(T.isSignedInt(from) ? 'sext' : 'zext', v, tt);
  }

  /** Default argument promotions (variadic / unprototyped calls). */
  private defaultPromote(v: Value, t: T.CType): { v: Value; t: T.CType } {
    const d = T.decay(t);
    if (d.kind === 'float' && d.bytes === 4) return { v: this.toType(v, d, T.DOUBLE), t: T.DOUBLE };
    if (T.isInteger(d) && T.sizeof(d) < 4) return { v: this.toType(v, d, T.INT), t: T.INT };
    return { v, t: d };
  }

  /** Evaluate an expression for its value. Aggregates yield their address. */
  private rvalue(e: A.Expr): Value {
    switch (e.kind) {
      case 'IntLit': return constInt(irTypeOf(this.exprType(e)), e.value);
      case 'FloatLit': return constFloat(irTypeOf(this.exprType(e)), e.value);
      case 'CharLit': return constInt('i32', e.value);
      case 'StringLit': return this.strAddr(e.bytes);
      case 'Ident': return this.identValue(e);
      case 'IndexExpr':
      case 'MemberExpr': {
        const lv = this.lvalue(e);
        return this.loadFrom(lv.addr, lv.type);
      }
      case 'UnaryExpr': return this.unary(e);
      case 'BinaryExpr': return this.binary(e);
      case 'AssignExpr': return this.assign(e);
      case 'CondExpr': return this.conditional(e);
      case 'CommaExpr': {
        let v: Value = constInt('i32', 0);
        for (const x of e.items) v = this.rvalue(x);
        return v;
      }
      case 'CastExpr': {
        const inner = this.rvalue(e.operand);
        const to = this.exprType(e);
        if (to.kind === 'void') return inner;
        return this.toType(inner, this.exprType(e.operand), to);
      }
      case 'CallExpr': return this.call(e);
      case 'SizeofExpr': return constInt('i32', T.sizeof(this.exprType(e.operand)));
      case 'SizeofType': return constInt('i32', T.sizeof(this.typeOfTypeName(e.type)));
    }
  }

  private identValue(e: A.Ident): Value {
    const sym = this.sema.useOf.get(e);
    if (sym?.kind === 'enumerator') return constInt('i32', sym.enumValue ?? 0);
    if (sym?.kind === 'func' || !sym) {
      const dst = this.newReg('ptr', e.name);
      this.calledNames.add(e.name);
      this.emit({ op: 'funcaddr', dst, name: e.name });
      return dst;
    }
    const lv = this.lvalue(e);
    return this.loadFrom(lv.addr, lv.type);
  }

  /** Load a C object of `type` at `addr`; arrays/functions/aggregates decay to the address. */
  private loadFrom(addr: Value, type: T.CType): Value {
    if (type.kind === 'array' || type.kind === 'function' || isAggregate(type)) return addr;
    return this.load(addr, irTypeOf(type));
  }

  private symbolAddr(sym: SymbolInfo, span: Span): Value {
    const local = this.ctx.localAddr.get(sym.id);
    if (local) return local;
    const g = this.globalNameOfSym.get(sym.id);
    if (g) {
      // Cache the address per function for readability (one `addr` per global).
      const cached = this.ctx.globalRegs.get(g);
      if (cached && this.ctx.cur === this.ctx.fn.blocks[0]) return cached;
      return this.globalAddr(g);
    }
    throw new LowerError(`'${sym.name}' has no storage`, span);
  }

  private lvalue(e: A.Expr): LValue {
    switch (e.kind) {
      case 'Ident': {
        const sym = this.sema.useOf.get(e);
        if (!sym) throw new LowerError(`'${e.name}' is not an lvalue`, e.span);
        if (sym.kind === 'func') {
          const dst = this.newReg('ptr', e.name);
          this.calledNames.add(e.name);
          this.emit({ op: 'funcaddr', dst, name: e.name });
          return { addr: dst, type: sym.type };
        }
        return { addr: this.symbolAddr(sym, e.span), type: sym.type };
      }
      case 'UnaryExpr':
        if (e.op === '*') {
          const p = this.rvalue(e.operand);
          const pt = T.decay(this.exprType(e.operand));
          return { addr: p, type: pt.kind === 'pointer' ? pt.to : T.INT };
        }
        break;
      case 'IndexExpr': {
        let baseE = e.base;
        let idxE = e.index;
        let bt = T.decay(this.exprType(baseE));
        if (bt.kind !== 'pointer') {
          // `2[a]` — swap
          const alt = T.decay(this.exprType(idxE));
          if (alt.kind === 'pointer') {
            [baseE, idxE] = [idxE, baseE];
            bt = alt;
          }
        }
        const base = this.rvalue(baseE);
        const idx = this.toType(this.rvalue(idxE), this.exprType(idxE), T.INT);
        const elem = bt.kind === 'pointer' ? bt.to : T.INT;
        return { addr: this.ptradd(base, idx, Math.max(1, T.sizeof(elem))), type: elem };
      }
      case 'MemberExpr': {
        let baseAddr: Value;
        let st: T.CType;
        if (e.arrow) {
          baseAddr = this.rvalue(e.base);
          const d = T.decay(this.exprType(e.base));
          st = d.kind === 'pointer' ? d.to : T.INT;
        } else {
          const bt = this.exprType(e.base);
          if (isAggregate(bt) && (e.base.kind === 'CallExpr' || e.base.kind === 'AssignExpr' || e.base.kind === 'CondExpr')) {
            baseAddr = this.rvalue(e.base);
            st = bt;
          } else {
            const lv = this.lvalue(e.base);
            baseAddr = lv.addr;
            st = lv.type;
          }
        }
        if (!isAggregate(st)) throw new LowerError('member access on non-struct', e.span);
        const f = st.fields.find((x) => x.name === e.name);
        if (!f) throw new LowerError(`no member '${e.name}'`, e.span);
        return { addr: this.ptradd(baseAddr, constInt('i32', f.offset), 1), type: f.type };
      }
      case 'StringLit':
        return { addr: this.strAddr(e.bytes), type: this.exprType(e) };
      case 'CallExpr':
      case 'AssignExpr':
      case 'CondExpr': {
        const t = this.exprType(e);
        if (isAggregate(t)) return { addr: this.rvalue(e), type: t };
        break;
      }
      case 'CommaExpr': {
        const last = e.items[e.items.length - 1];
        for (let i = 0; i < e.items.length - 1; i++) this.rvalue(e.items[i]!);
        if (last) return this.lvalue(last);
        break;
      }
    }
    throw new LowerError('expression is not an lvalue', e.span);
  }

  private unary(e: A.UnaryExpr): Value {
    switch (e.op) {
      case '&': {
        if (e.operand.kind === 'Ident') {
          const sym = this.sema.useOf.get(e.operand);
          if (sym?.kind === 'func' || !sym) return this.identValue(e.operand);
        }
        return this.lvalue(e.operand).addr;
      }
      case '*': {
        const lv = this.lvalue(e);
        return this.loadFrom(lv.addr, lv.type);
      }
      case '++':
      case '--': {
        const lv = this.lvalue(e.operand);
        const old = this.loadFrom(lv.addr, lv.type);
        const next = this.addDelta(old, lv.type, e.op === '++' ? 1 : -1);
        this.emit({ op: 'store', addr: lv.addr, val: this.toType(next.v, next.t, lv.type) });
        return e.prefix ? this.toType(next.v, next.t, lv.type) : old;
      }
      case '+': {
        const v = this.rvalue(e.operand);
        const t = T.decay(this.exprType(e.operand));
        return T.isArithmetic(t) ? this.toType(v, t, T.promote(t)) : v;
      }
      case '-': {
        const v = this.rvalue(e.operand);
        const t = T.decay(this.exprType(e.operand));
        if (t.kind === 'float') return this.bin('fsub', v.type, constFloat(v.type, 0), v);
        const pt = T.promote(t);
        const pv = this.toType(v, t, pt);
        return this.bin('sub', pv.type, constInt(pv.type, 0), pv);
      }
      case '~': {
        const v = this.rvalue(e.operand);
        const t = T.decay(this.exprType(e.operand));
        const pt = T.promote(t);
        const pv = this.toType(v, t, pt);
        return this.bin('xor', pv.type, pv, constInt(pv.type, -1));
      }
      case '!':
        return this.cast('zext', this.truth(e), 'i32');
    }
  }

  /** v + delta (pointer-aware), returning the result and its C type. */
  private addDelta(v: Value, t: T.CType, delta: number): { v: Value; t: T.CType } {
    const d = T.decay(t);
    if (d.kind === 'pointer') return { v: this.ptradd(v, constInt('i32', delta), Math.max(1, T.sizeof(d.to))), t: d };
    if (d.kind === 'float') return { v: this.bin('fadd', v.type, v, constFloat(v.type, delta)), t: d };
    const pt = T.promote(d);
    const pv = this.toType(v, d, pt);
    return { v: this.bin('add', pv.type, pv, constInt(pv.type, delta)), t: pt };
  }

  private compare(e: A.BinaryExpr): Reg {
    const lt = T.decay(this.exprType(e.left));
    const rt = T.decay(this.exprType(e.right));
    let l = this.rvalue(e.left);
    let r = this.rvalue(e.right);
    let signed = true;
    let fp = false;
    if (lt.kind === 'pointer' || rt.kind === 'pointer') {
      if (lt.kind !== 'pointer') l = this.toType(l, lt, rt);
      if (rt.kind !== 'pointer') r = this.toType(r, rt, lt);
      signed = false;
    } else if (lt.kind === 'float' || rt.kind === 'float') {
      const ct = T.usualArithmetic(lt, rt);
      l = this.toType(l, lt, ct);
      r = this.toType(r, rt, ct);
      fp = true;
    } else {
      const ct = T.usualArithmetic(lt, rt);
      l = this.toType(l, lt, ct);
      r = this.toType(r, rt, ct);
      signed = T.isSignedInt(ct);
    }
    const opc = cmpOpc(e.op, signed, fp);
    return this.cmp(opc, l, r);
  }

  private binary(e: A.BinaryExpr): Value {
    if (e.op === '&&' || e.op === '||' || ['<', '>', '<=', '>=', '==', '!='].includes(e.op)) {
      return this.cast('zext', this.truth(e), 'i32');
    }
    const lt = T.decay(this.exprType(e.left));
    const rt = T.decay(this.exprType(e.right));
    const l = this.rvalue(e.left);
    const r = this.rvalue(e.right);
    return this.arith(e.op, l, lt, r, rt).v;
  }

  /** Arithmetic binary operator on IR values with C types; returns value + C type. */
  private arith(op: string, l: Value, lt: T.CType, r: Value, rt: T.CType): { v: Value; t: T.CType } {
    if (lt.kind === 'pointer' && (op === '+' || op === '-') && T.isInteger(rt)) {
      let idx = this.toType(r, rt, T.INT);
      if (op === '-') idx = this.bin('sub', 'i32', constInt('i32', 0), idx);
      return { v: this.ptradd(l, idx, Math.max(1, T.sizeof(lt.to))), t: lt };
    }
    if (rt.kind === 'pointer' && op === '+' && T.isInteger(lt)) {
      const idx = this.toType(l, lt, T.INT);
      return { v: this.ptradd(r, idx, Math.max(1, T.sizeof(rt.to))), t: rt };
    }
    if (lt.kind === 'pointer' && rt.kind === 'pointer' && op === '-') {
      const a = this.cast('ptrtoint', l, 'i32');
      const b = this.cast('ptrtoint', r, 'i32');
      const diff = this.bin('sub', 'i32', a, b);
      const sz = Math.max(1, T.sizeof(lt.to));
      return { v: sz === 1 ? diff : this.bin('sdiv', 'i32', diff, constInt('i32', sz)), t: T.LONG };
    }
    if (op === '<<' || op === '>>') {
      const pt = T.promote(lt);
      const a = this.toType(l, lt, pt);
      const b = this.toType(r, rt, pt);
      const opc: BinOp = op === '<<' ? 'shl' : T.isSignedInt(pt) ? 'ashr' : 'lshr';
      return { v: this.bin(opc, a.type, a, b), t: pt };
    }
    const ct = T.usualArithmetic(lt, rt);
    const a = this.toType(l, lt, ct);
    const b = this.toType(r, rt, ct);
    if (ct.kind === 'float') {
      const opc: BinOp = op === '+' ? 'fadd' : op === '-' ? 'fsub' : op === '*' ? 'fmul' : 'fdiv';
      return { v: this.bin(opc, a.type, a, b), t: ct };
    }
    const signed = T.isSignedInt(ct);
    let opc: BinOp;
    switch (op) {
      case '+': opc = 'add'; break;
      case '-': opc = 'sub'; break;
      case '*': opc = 'mul'; break;
      case '/': opc = signed ? 'sdiv' : 'udiv'; break;
      case '%': opc = signed ? 'srem' : 'urem'; break;
      case '&': opc = 'and'; break;
      case '|': opc = 'or'; break;
      case '^': opc = 'xor'; break;
      default: throw new LowerError(`unsupported operator '${op}'`);
    }
    return { v: this.bin(opc, a.type, a, b), t: ct };
  }

  private assign(e: A.AssignExpr): Value {
    const lv = this.lvalue(e.target);
    if (isAggregate(lv.type)) {
      const src = this.rvalue(e.value);
      this.emit({ op: 'memcpy', dst: lv.addr, src, len: constInt('i32', T.sizeof(lv.type)) });
      return lv.addr;
    }
    let value: Value;
    if (e.op === '=') {
      value = this.toType(this.rvalue(e.value), this.exprType(e.value), lv.type);
    } else {
      const cur = this.loadFrom(lv.addr, lv.type);
      const rhs = this.rvalue(e.value);
      const res = this.arith(e.op.slice(0, -1), cur, T.decay(lv.type), rhs, T.decay(this.exprType(e.value)));
      value = this.toType(res.v, res.t, lv.type);
    }
    this.emit({ op: 'store', addr: lv.addr, val: value });
    return value;
  }

  private conditional(e: A.CondExpr): Value {
    const resT = this.exprType(e);
    const thenB = this.newBlock('cond.true');
    const elseB = this.newBlock('cond.false');
    const endB = this.newBlock('cond.end');
    this.emit({ op: 'condbr', cond: this.truth(e.cond), then: thenB.name, else: elseB.name });
    this.ctx.cur = thenB;
    const a = this.toType(this.rvalue(e.then), this.exprType(e.then), resT);
    const aBlock = this.ctx.cur.name;
    this.emit({ op: 'br', target: endB.name });
    this.ctx.cur = elseB;
    const b = this.toType(this.rvalue(e.else), this.exprType(e.else), resT);
    const bBlock = this.ctx.cur.name;
    this.emit({ op: 'br', target: endB.name });
    this.ctx.cur = endB;
    if (resT.kind === 'void') return constInt('i32', 0);
    const dst = this.newReg(isAggregate(resT) ? 'ptr' : irTypeOf(resT));
    this.emit({ op: 'phi', dst, incoming: [{ value: a, block: aBlock }, { value: b, block: bBlock }] });
    return dst;
  }

  private call(e: A.CallExpr): Value {
    // Resolve the callee: a direct call by name, or an indirect call through a pointer.
    let callee: string | Value;
    let ftype: T.FunctionType | null = null;
    const calleeT = T.decay(this.exprType(e.callee));
    if (calleeT.kind === 'pointer' && calleeT.to.kind === 'function') ftype = calleeT.to;
    else if (calleeT.kind === 'function') ftype = calleeT;
    if (e.callee.kind === 'Ident') {
      const sym = this.sema.useOf.get(e.callee);
      if (!sym || sym.kind === 'func') {
        callee = e.callee.name;
        this.calledNames.add(e.callee.name);
        if (!ftype) ftype = this.funcTypes.get(e.callee.name) ?? null;
      } else callee = this.rvalue(e.callee);
    } else callee = this.rvalue(e.callee);

    const retC = ftype ? ftype.ret : T.INT;
    const args: Value[] = [];
    const params: IrType[] = [];
    let sretTmp: Reg | null = null;
    if (isAggregate(retC)) {
      sretTmp = this.alloca(retC, 'tmp.ret');
      args.push(sretTmp);
      params.push('ptr');
    }
    const proto = ftype?.hasProto ? ftype.params : null;
    e.args.forEach((argE, i) => {
      const at = this.exprType(argE);
      let v = this.rvalue(argE);
      const pt = proto && i < proto.length ? proto[i]! : null;
      if (isAggregate(T.decay(at))) {
        // Pass a fresh copy by pointer (the callee owns it).
        const tmp = this.alloca(at, 'tmp.arg');
        this.emit({ op: 'memcpy', dst: tmp, src: v, len: constInt('i32', T.sizeof(at)) });
        args.push(tmp);
        params.push('ptr');
        return;
      }
      if (pt) {
        v = this.toType(v, at, pt);
        args.push(v);
        params.push(v.type);
      } else {
        const p = this.defaultPromote(v, at);
        args.push(p.v);
        params.push(p.v.type);
      }
    });
    const sig: Sig = { ret: sretTmp ? 'void' : irTypeOf(retC), params, variadic: ftype?.variadic ?? !proto };
    if (sig.ret === 'void') {
      this.emit({ op: 'call', callee, args, sig });
      return sretTmp ?? constInt('i32', 0);
    }
    const dst = this.newReg(sig.ret);
    this.emit({ op: 'call', dst, callee, args, sig });
    return dst;
  }
}

// -- small helpers -------------------------------------------------------------

function effectiveType(type: T.CType, init: A.Initializer | null): T.CType {
  if (type.kind === 'array' && type.length === null && init) {
    if (init.kind === 'ListInit') {
      let max = 0;
      let idx = 0;
      for (const item of init.items) {
        const d = item.designators[0];
        if (d && d.kind === 'array' && d.index.kind === 'IntLit') idx = Number(d.index.value);
        idx++;
        max = Math.max(max, idx);
      }
      return T.arrayOf(type.of, max);
    }
    if (init.kind === 'ExprInit' && init.expr.kind === 'StringLit') return T.arrayOf(type.of, init.expr.bytes.length + 1);
  }
  return type;
}

function zeroOf(t: IrType): Const {
  return t === 'f32' || t === 'f64' ? constFloat(t, 0) : constInt(t, 0);
}

function narrowInt(v: bigint, bytes: number, signed: boolean): bigint {
  return signed ? BigInt.asIntN(bytes * 8, v) : BigInt.asUintN(bytes * 8, v);
}

function constBinary(op: string, a: bigint, b: bigint): bigint | null {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0n ? null : a / b;
    case '%': return b === 0n ? null : a % b;
    case '<<': return a << b;
    case '>>': return a >> b;
    case '&': return a & b;
    case '|': return a | b;
    case '^': return a ^ b;
    case '<': return a < b ? 1n : 0n;
    case '>': return a > b ? 1n : 0n;
    case '<=': return a <= b ? 1n : 0n;
    case '>=': return a >= b ? 1n : 0n;
    case '==': return a === b ? 1n : 0n;
    case '!=': return a !== b ? 1n : 0n;
    case '&&': return a !== 0n && b !== 0n ? 1n : 0n;
    case '||': return a !== 0n || b !== 0n ? 1n : 0n;
    default: return null;
  }
}

function cmpOpc(op: string, signed: boolean, fp: boolean): CmpOp {
  if (fp) {
    switch (op) {
      case '<': return 'olt';
      case '>': return 'ogt';
      case '<=': return 'ole';
      case '>=': return 'oge';
      case '==': return 'oeq';
      default: return 'one';
    }
  }
  switch (op) {
    case '<': return signed ? 'slt' : 'ult';
    case '>': return signed ? 'sgt' : 'ugt';
    case '<=': return signed ? 'sle' : 'ule';
    case '>=': return signed ? 'sge' : 'uge';
    case '==': return 'eq';
    default: return 'ne';
  }
}

function foldCast(opc: CastOp, c: Const, to: IrType): Const | null {
  switch (opc) {
    case 'trunc': case 'sext': case 'zext': case 'bitcast': case 'inttoptr': case 'ptrtoint': {
      let v = c.i;
      if (opc === 'zext') v = BigInt.asUintN(bits(c.type), v);
      return constInt(to, v);
    }
    case 'sitofp': return constFloat(to, Number(c.i));
    case 'uitofp': return constFloat(to, Number(BigInt.asUintN(bits(c.type), c.i)));
    case 'fpext': case 'fptrunc': return constFloat(to, c.f);
    case 'fptosi': case 'fptoui': return Number.isFinite(c.f) ? constInt(to, BigInt(Math.trunc(c.f))) : constInt(to, 0);
  }
}
function bits(t: IrType): number {
  return t === 'i1' ? 1 : t === 'i8' ? 8 : t === 'i16' ? 16 : t === 'i64' || t === 'f64' ? 64 : 32;
}

function collectLabels(s: A.Stmt | A.Declaration, f: (label: string) => void): void {
  switch (s.kind) {
    case 'LabeledStmt': f(s.label); collectLabels(s.stmt, f); break;
    case 'CompoundStmt': for (const i of s.items) collectLabels(i, f); break;
    case 'IfStmt': collectLabels(s.then, f); if (s.else) collectLabels(s.else, f); break;
    case 'WhileStmt': case 'DoWhileStmt': case 'ForStmt': case 'SwitchStmt': collectLabels(s.body, f); break;
    case 'CaseStmt': case 'DefaultStmt': collectLabels(s.stmt, f); break;
    default: break;
  }
}

/**
 * Rebuild a C type from a TypeName node. sema does not keep a per-TypeName
 * map, so we reconstruct basic/pointer/array shapes directly; typedef and
 * tag names are looked up through the symbols sema recorded.
 */
export function typeFromTypeName(tn: A.TypeName, sema: SemaResult): T.CType {
  let base: T.CType = T.INT;
  const specs = tn.specifiers;
  const td = specs.typeSpecs.find((s) => s.kind === 'TypedefName') as A.TypedefNameSpec | undefined;
  const su = specs.typeSpecs.find((s) => s.kind === 'StructUnion') as A.StructUnionSpec | undefined;
  const en = specs.typeSpecs.find((s) => s.kind === 'Enum') as A.EnumSpec | undefined;
  if (td) {
    for (const sym of sema.symOf.values()) if (sym.kind === 'typedef' && sym.name === td.name) base = sym.type;
  } else if (su) {
    // Find a struct/union type with this tag among typed expressions / symbols.
    const found = findTagType(sema, su.su, su.tag);
    base = found ?? { kind: su.su, tag: su.tag, fields: [], size: 0, align: 1, complete: false, id: -1 };
  } else if (en) {
    base = { kind: 'enum', tag: en.tag, complete: true };
  } else {
    const names = specs.typeSpecs.filter((s): s is A.BasicTypeSpec => s.kind === 'BasicType').map((s) => s.name);
    const has = (n: string) => names.includes(n as A.BasicTypeSpec['name']);
    const count = (n: string) => names.filter((x) => x === n).length;
    const unsigned = has('unsigned');
    if (has('void')) base = T.VOID;
    else if (has('_Bool')) base = T.BOOL;
    else if (has('double')) base = T.DOUBLE;
    else if (has('float')) base = T.FLOAT;
    else if (has('char')) base = unsigned ? T.UCHAR : has('signed') ? T.SCHAR : T.CHAR;
    else if (has('short')) base = unsigned ? T.USHORT : T.SHORT;
    else if (count('long') >= 2) base = unsigned ? T.ULLONG : T.LLONG;
    else if (has('long')) base = unsigned ? T.ULONG : T.LONG;
    else base = unsigned ? T.UINT : T.INT;
  }
  base = T.withQual(base, specs.qualConst, specs.qualVolatile);
  return applyAbstract(base, tn.declarator, sema);
}

function applyAbstract(base: T.CType, d: A.Declarator | null, sema: SemaResult): T.CType {
  if (!d || d.kind === 'IdentDeclarator') return base;
  if (d.kind === 'PointerDeclarator') return applyAbstract(T.withQual(T.pointerTo(base), d.qualConst, d.qualVolatile), d.inner, sema);
  if (d.kind === 'ArrayDeclarator') {
    let n: number | null = null;
    if (d.size && d.size.kind === 'IntLit') n = Number(d.size.value);
    return applyAbstract(T.arrayOf(base, n), d.inner, sema);
  }
  const params: T.CType[] = [];
  for (const p of d.params) {
    if (p.declarator === null && p.specifiers.typeSpecs.length === 0) continue;
    const pt = T.decay(typeFromTypeName({ specifiers: p.specifiers, declarator: p.declarator, span: p.span }, sema));
    if (pt.kind !== 'void') params.push(pt);
  }
  const fn: T.FunctionType = { kind: 'function', ret: base, params, variadic: d.variadic, hasProto: d.hasProto };
  return applyAbstract(fn, d.inner, sema);
}

function findTagType(sema: SemaResult, su: 'struct' | 'union', tag: string | undefined): T.CType | null {
  if (!tag) return null;
  const visit = (t: T.CType): T.CType | null => {
    if ((t.kind === 'struct' || t.kind === 'union') && t.kind === su && t.tag === tag && t.complete) return t;
    if (t.kind === 'pointer') return visit(t.to);
    if (t.kind === 'array') return visit(t.of);
    if (t.kind === 'function') {
      const r = visit(t.ret);
      if (r) return r;
      for (const p of t.params) {
        const q = visit(p);
        if (q) return q;
      }
    }
    return null;
  };
  for (const sym of sema.symOf.values()) {
    const r = visit(sym.type);
    if (r) return r;
  }
  for (const t of sema.typeOf.values()) {
    const r = visit(t);
    if (r) return r;
  }
  return null;
}
