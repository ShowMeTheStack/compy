import { describe, it, expect } from 'vitest';
import { preprocess } from './preprocessor';
import { parse } from './parser';
import * as A from './ast';

function parseUnit(src: string) {
  const { tokens } = preprocess(src);
  const { unit, diagnostics } = parse(tokens);
  return { unit, errors: diagnostics.filter((d) => d.severity === 'error') };
}

/** Render specifiers+declarator as a readable type string (buildType preview). */
function typeStr(specifiers: A.DeclSpecifiers, decl: A.Declarator | null): string {
  const base = specifiers.typeSpecs
    .map((t) => (t.kind === 'BasicType' ? t.name : t.kind === 'TypedefName' ? t.name : t.kind === 'StructUnion' ? `${t.su} ${t.tag ?? ''}`.trim() : `enum ${t.tag ?? ''}`.trim()))
    .join(' ');
  const walk = (d: A.Declarator | null, b: string): string => {
    if (!d || d.kind === 'IdentDeclarator') return b;
    if (d.kind === 'PointerDeclarator') return walk(d.inner, `ptr(${b})`);
    if (d.kind === 'ArrayDeclarator') {
      const n = d.size && d.size.kind === 'IntLit' ? String(d.size.value) : d.size ? 'vla' : '';
      return walk(d.inner, `arr(${n},${b})`);
    }
    return walk(d.inner, `fn(${b})`);
  };
  return walk(decl, base || 'int');
}

function firstDecl(src: string): { spec: A.DeclSpecifiers; decl: A.Declarator } {
  const { unit } = parseUnit(src);
  const d = unit.decls[0]!;
  if (d.kind === 'Declaration') return { spec: d.specifiers, decl: d.declarators[0]!.declarator };
  return { spec: d.specifiers, decl: d.declarator };
}

describe('declarator nesting', () => {
  it('int *a[3] is array of pointer', () => {
    const { spec, decl } = firstDecl('int *a[3];');
    expect(typeStr(spec, decl)).toBe('arr(3,ptr(int))');
  });
  it('int (*a)[3] is pointer to array', () => {
    const { spec, decl } = firstDecl('int (*a)[3];');
    expect(typeStr(spec, decl)).toBe('ptr(arr(3,int))');
  });
  it('int a[3][4] is array 3 of array 4', () => {
    const { spec, decl } = firstDecl('int a[3][4];');
    expect(typeStr(spec, decl)).toBe('arr(3,arr(4,int))');
  });
  it('int (*f)(int) is pointer to function', () => {
    const { spec, decl } = firstDecl('int (*f)(int);');
    expect(typeStr(spec, decl)).toBe('ptr(fn(int))');
  });
  it('int *f(void) is function returning pointer', () => {
    const { spec, decl } = firstDecl('int *f(void);');
    expect(typeStr(spec, decl)).toBe('fn(ptr(int))');
  });
  it('char **argv is pointer to pointer', () => {
    const { spec, decl } = firstDecl('char **argv;');
    expect(typeStr(spec, decl)).toBe('ptr(ptr(char))');
  });
});

describe('functions', () => {
  it('parses a function definition with a body', () => {
    const { unit, errors } = parseUnit('int main(void) { return 0; }');
    expect(errors).toEqual([]);
    const fn = unit.decls[0]!;
    expect(fn.kind).toBe('FunctionDef');
    if (fn.kind === 'FunctionDef') {
      expect(A.declaratorName(fn.declarator)).toBe('main');
      expect(fn.body.items).toHaveLength(1);
      expect(fn.body.items[0]!.kind).toBe('ReturnStmt');
    }
  });
  it('parses parameters', () => {
    const { unit } = parseUnit('int add(int a, int b) { return a + b; }');
    const fn = unit.decls[0]!;
    if (fn.kind === 'FunctionDef' && fn.declarator.kind === 'FunctionDeclarator') {
      expect(fn.declarator.params).toHaveLength(2);
      expect(fn.declarator.hasProto).toBe(true);
    }
  });
});

describe('typedef disambiguation', () => {
  it('treats a typedef name as a type', () => {
    const { unit, errors } = parseUnit('typedef int myint;\nmyint x;');
    expect(errors).toEqual([]);
    const d = unit.decls[1]!;
    expect(d.kind).toBe('Declaration');
    if (d.kind === 'Declaration') {
      expect(d.specifiers.typeSpecs[0]!.kind).toBe('TypedefName');
    }
  });
  it('parses a cast using a typedef name', () => {
    const { unit, errors } = parseUnit('typedef int T;\nint f(void){ return (T)3; }');
    expect(errors).toEqual([]);
    const fn = unit.decls[1]!;
    if (fn.kind === 'FunctionDef') {
      const ret = fn.body.items[0]!;
      expect(ret.kind).toBe('ReturnStmt');
      if (ret.kind === 'ReturnStmt') expect(ret.value!.kind).toBe('CastExpr');
    }
  });
});

describe('expressions', () => {
  function exprOf(src: string): A.Expr {
    const { unit } = parseUnit(`int f(void){ return ${src}; }`);
    const fn = unit.decls[0]!;
    if (fn.kind === 'FunctionDef') {
      const ret = fn.body.items[0]!;
      if (ret.kind === 'ReturnStmt') return ret.value!;
    }
    throw new Error('no expr');
  }
  it('respects precedence: 1 + 2 * 3', () => {
    const e = exprOf('1 + 2 * 3');
    expect(e.kind).toBe('BinaryExpr');
    if (e.kind === 'BinaryExpr') {
      expect(e.op).toBe('+');
      expect(e.right.kind).toBe('BinaryExpr'); // 2*3 binds tighter
    }
  });
  it('parses assignment right-associatively', () => {
    const e = exprOf('a = b = c');
    expect(e.kind).toBe('AssignExpr');
    if (e.kind === 'AssignExpr') expect(e.value.kind).toBe('AssignExpr');
  });
  it('parses ternary', () => {
    expect(exprOf('a ? b : c').kind).toBe('CondExpr');
  });
  it('parses postfix chains a.b->c[0](1)', () => {
    const e = exprOf('a.b->c[0](1)');
    expect(e.kind).toBe('CallExpr');
  });
  it('parses sizeof type and sizeof expr', () => {
    expect(exprOf('sizeof(int)').kind).toBe('SizeofType');
    expect(exprOf('sizeof x').kind).toBe('SizeofExpr');
  });
  it('concatenates adjacent string literals', () => {
    const e = exprOf('"ab" "cd"');
    expect(e.kind).toBe('StringLit');
    if (e.kind === 'StringLit') expect(e.bytes).toEqual([97, 98, 99, 100]);
  });
});

describe('statements', () => {
  function stmts(src: string): A.BlockItem[] {
    const { unit, errors } = parseUnit(`int f(void){ ${src} }`);
    expect(errors).toEqual([]);
    const fn = unit.decls[0]!;
    if (fn.kind === 'FunctionDef') return fn.body.items;
    return [];
  }
  it('if/else', () => {
    const s = stmts('if (x) return 1; else return 2;')[0]!;
    expect(s.kind).toBe('IfStmt');
    if (s.kind === 'IfStmt') expect(s.else).not.toBeNull();
  });
  it('for with an init declaration (friendly extra)', () => {
    const s = stmts('for (int i = 0; i < 10; i++) x++;')[0]!;
    expect(s.kind).toBe('ForStmt');
    if (s.kind === 'ForStmt') expect((s.init as A.Declaration).kind).toBe('Declaration');
  });
  it('while and do-while', () => {
    expect(stmts('while (1) break;')[0]!.kind).toBe('WhileStmt');
    expect(stmts('do x++; while (x < 3);')[0]!.kind).toBe('DoWhileStmt');
  });
  it('switch with case and default', () => {
    const s = stmts('switch (x) { case 1: break; default: break; }')[0]!;
    expect(s.kind).toBe('SwitchStmt');
  });
  it('labels and goto', () => {
    const items = stmts('goto end; end: return 0;');
    expect(items[0]!.kind).toBe('GotoStmt');
    expect(items[1]!.kind).toBe('LabeledStmt');
  });
  it('mixed declarations and statements (friendly extra)', () => {
    const items = stmts('int a = 1; a++; int b = 2;');
    expect(items.map((i) => i.kind)).toEqual(['Declaration', 'ExprStmt', 'Declaration']);
  });
});

describe('struct / union / enum', () => {
  it('parses a struct with fields', () => {
    const { unit, errors } = parseUnit('struct Point { int x; int y; };');
    expect(errors).toEqual([]);
    const d = unit.decls[0]!;
    if (d.kind === 'Declaration') {
      const spec = d.specifiers.typeSpecs[0]!;
      expect(spec.kind).toBe('StructUnion');
      if (spec.kind === 'StructUnion') {
        expect(spec.tag).toBe('Point');
        expect(spec.fields).toHaveLength(2);
      }
    }
  });
  it('parses an enum with values', () => {
    const { unit } = parseUnit('enum Color { RED, GREEN = 5, BLUE };');
    const d = unit.decls[0]!;
    if (d.kind === 'Declaration') {
      const spec = d.specifiers.typeSpecs[0]!;
      if (spec.kind === 'Enum') {
        expect(spec.enumerators!.map((e) => e.name)).toEqual(['RED', 'GREEN', 'BLUE']);
      }
    }
  });
});

describe('initializers', () => {
  it('parses a brace-enclosed initializer list', () => {
    const { unit } = parseUnit('int a[3] = {1, 2, 3};');
    const d = unit.decls[0]!;
    if (d.kind === 'Declaration') {
      const init = d.declarators[0]!.init!;
      expect(init.kind).toBe('ListInit');
      if (init.kind === 'ListInit') expect(init.items).toHaveLength(3);
    }
  });
  it('parses designated initializers (friendly extra)', () => {
    const { unit, errors } = parseUnit('struct P { int x, y; } p = { .y = 2, .x = 1 };');
    expect(errors).toEqual([]);
    const d = unit.decls[0]!;
    if (d.kind === 'Declaration') {
      const init = d.declarators[0]!.init!;
      if (init.kind === 'ListInit') {
        expect(init.items[0]!.designators[0]!).toMatchObject({ kind: 'field', name: 'y' });
      }
    }
  });
});
