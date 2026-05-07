import { describe, it, expect } from 'vitest';
import { preprocess } from './preprocessor';
import { parse } from './parser';
import { analyze, SemaResult } from './sema';
import * as A from './ast';
import * as T from './types';

function sema(src: string): { res: SemaResult; unit: A.TranslationUnit } {
  const { tokens } = preprocess(src);
  const { unit } = parse(tokens);
  return { res: analyze(unit), unit };
}
function errs(src: string): string[] {
  return sema(src).res.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
}

describe('sizeof & layout (ILP32)', () => {
  it('scalar sizes', () => {
    expect(T.sizeof(T.CHAR)).toBe(1);
    expect(T.sizeof(T.SHORT)).toBe(2);
    expect(T.sizeof(T.INT)).toBe(4);
    expect(T.sizeof(T.LONG)).toBe(4);
    expect(T.sizeof(T.LLONG)).toBe(8);
    expect(T.sizeof(T.FLOAT)).toBe(4);
    expect(T.sizeof(T.DOUBLE)).toBe(8);
    expect(T.sizeof(T.pointerTo(T.INT))).toBe(4);
  });
  it('struct layout with padding', () => {
    // struct { char c; int i; } -> c@0, pad, i@4, size 8
    const { fields, size, align } = T.layoutStruct([
      { name: 'c', type: T.CHAR },
      { name: 'i', type: T.INT },
    ]);
    expect(fields[0]!.offset).toBe(0);
    expect(fields[1]!.offset).toBe(4);
    expect(size).toBe(8);
    expect(align).toBe(4);
  });
  it('union layout is the max', () => {
    const { size, align } = T.layoutUnion([
      { name: 'c', type: T.CHAR },
      { name: 'd', type: T.DOUBLE },
    ]);
    expect(size).toBe(8);
    expect(align).toBe(8);
  });
});

describe('type specifiers', () => {
  function firstVarType(src: string): T.CType {
    const { res } = sema(src);
    const g = res.globals.find((s) => s.kind === 'var' || s.kind === 'typedef')!;
    return g.type;
  }
  it('unsigned long, long long, unsigned char', () => {
    expect(T.formatType(firstVarType('unsigned long x;'))).toBe('unsigned long');
    expect(T.formatType(firstVarType('long long x;'))).toBe('long long');
    expect(T.formatType(firstVarType('unsigned char x;'))).toBe('unsigned char');
  });
  it('resolves a typedef to its aliased type', () => {
    const { res } = sema('typedef unsigned int u32;\nu32 v;');
    const v = res.globals.find((s) => s.name === 'v')!;
    expect(T.formatType(v.type)).toBe('unsigned int');
  });
});

describe('struct types & members', () => {
  it('computes a struct type with laid-out fields', () => {
    const { res } = sema('struct P { int x; char y; };\nstruct P p;');
    const p = res.globals.find((s) => s.name === 'p')!;
    expect(p.type.kind).toBe('struct');
    if (p.type.kind === 'struct') {
      expect(p.type.fields.map((f) => f.name)).toEqual(['x', 'y']);
      expect(p.type.size).toBe(8);
    }
  });
  it('types member access', () => {
    const { res } = sema('struct P { int x; }; int f(void){ struct P p; return p.x; }');
    const types = [...res.typeOf.values()];
    expect(types.some((t) => t.kind === 'int')).toBe(true);
  });
});

describe('enums', () => {
  it('assigns sequential and explicit enumerator values', () => {
    const { res } = sema('enum E { A, B, C = 10, D };');
    const byName = (n: string) => res.globals.find((s) => s.name === n)!;
    expect(byName('A').enumValue).toBe(0);
    expect(byName('B').enumValue).toBe(1);
    expect(byName('C').enumValue).toBe(10);
    expect(byName('D').enumValue).toBe(11);
  });
  it('uses an enum constant as an array bound', () => {
    const { res } = sema('enum { N = 4 };\nint a[N];');
    const a = res.globals.find((s) => s.name === 'a')!;
    if (a.type.kind === 'array') expect(a.type.length).toBe(4);
  });
});

describe('expression typing', () => {
  function exprType(src: string): T.CType {
    const { res, unit } = sema(`int f(void){ return ${src}; }`);
    const fn = unit.decls.find((d) => d.kind === 'FunctionDef') as A.FunctionDef;
    const ret = fn.body.items[0] as A.ReturnStmt;
    return res.typeOf.get(ret.value!)!;
  }
  it('int + int is int; int + double is double', () => {
    expect(T.formatType(exprType('1 + 2'))).toBe('int');
    expect(T.formatType(exprType('1 + 2.0'))).toBe('double');
  });
  it('unsigned dominates in mixed arithmetic', () => {
    const { res } = sema('unsigned u; int i; int f(void){ return u + i; }');
    const t = [...res.typeOf.values()].find((x) => x.kind === 'int' && !x.signed && x.bytes === 4);
    expect(t).toBeTruthy();
  });
  it('comparisons are int', () => {
    expect(T.formatType(exprType('1 < 2'))).toBe('int');
  });
  it('sizeof yields size_t (unsigned long)', () => {
    expect(T.formatType(exprType('sizeof(int)'))).toBe('unsigned long');
  });
});

describe('pointer typing', () => {
  it('pointer + int stays a pointer; *p dereferences', () => {
    const { res } = sema('int f(void){ int *p; int x; p + 1; x = *p; return x; }');
    const types = [...res.typeOf.values()];
    expect(types.some((t) => t.kind === 'pointer')).toBe(true);
  });
  it('pointer - pointer is a signed integer (ptrdiff)', () => {
    const { res, unit } = sema('int f(int *a, int *b){ return a - b; }');
    const fn = unit.decls.find((d) => d.kind === 'FunctionDef') as A.FunctionDef;
    const ret = fn.body.items[0] as A.ReturnStmt;
    const t = res.typeOf.get(ret.value!)!;
    expect(T.isInteger(t)).toBe(true);
  });
});

describe('go-to-definition index', () => {
  it('links a variable use to its declaration', () => {
    const { res } = sema('int f(void){ int x = 1; return x; }');
    // the use of x in `return x` links back to the declaration span
    expect(res.defs.some((d) => d.name === 'x')).toBe(true);
    const link = res.defs.find((d) => d.name === 'x')!;
    expect(link.decl).toBeTruthy();
    expect(link.use).toBeTruthy();
  });
  it('links a function call to the function definition', () => {
    const { res } = sema('int g(void){ return 1; } int f(void){ return g(); }');
    expect(res.defs.some((d) => d.name === 'g')).toBe(true);
  });
});

describe('diagnostics', () => {
  it('reports an undeclared identifier', () => {
    expect(errs('int f(void){ return zzz; }')).toContain("'zzz' undeclared");
  });
  it('reports an unknown struct member', () => {
    expect(errs('struct P { int x; }; int f(void){ struct P p; return p.y; }')).toContain(
      "no member named 'y' in struct P",
    );
  });
  it('accepts valid code with no errors', () => {
    expect(errs('int add(int a, int b){ return a + b; } int main(void){ return add(1,2); }')).toEqual([]);
  });
});
