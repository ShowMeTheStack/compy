import { describe, it, expect } from 'vitest';
import { preprocess, parse, analyze } from '@cide/cc';
import { run } from '@cide/vm';
import { Console } from '@cide/runtime';
import { createLibc } from './libc';

/** Compile and run a C program, returning its stdout and exit code. */
function exec(src: string, argv: string[] = ['prog']): { out: string; err: string; code: number } {
  const { tokens, diagnostics: ppDiags } = preprocess(src, { file: '/home/main.c' });
  const fatal = ppDiags.filter((d) => d.severity === 'error');
  if (fatal.length) throw new Error('preprocess: ' + fatal.map((d) => d.message).join('; '));
  const { unit, diagnostics: pDiags } = parse(tokens);
  const pErr = pDiags.filter((d) => d.severity === 'error');
  if (pErr.length) throw new Error('parse: ' + pErr.map((d) => d.message).join('; '));
  const sema = analyze(unit);
  const con = new Console();
  const res = run(unit, sema, { console: con, natives: createLibc(), argv });
  return { out: con.stdout(), err: con.stderr(), code: res.exitCode };
}

describe('basic programs', () => {
  it('hello world', () => {
    expect(exec('int puts(const char*); int main(void){ puts("Hello, world!"); return 0; }').out).toBe('Hello, world!\n');
  });
  it('printf with format specifiers', () => {
    const src = `int printf(const char*,...);
      int main(void){ printf("%d %s %c %.2f %x\\n", 42, "hi", 65, 3.14159, 255); return 0; }`;
    expect(exec(src).out).toBe('42 hi A 3.14 ff\n');
  });
  it('returns an exit code from main', () => {
    expect(exec('int main(void){ return 7; }').code).toBe(7);
  });
  it('arithmetic and precedence', () => {
    expect(exec('int printf(const char*,...); int main(void){ printf("%d", 2 + 3 * 4 - 1); return 0; }').out).toBe('13');
  });
});

describe('control flow', () => {
  it('for loop sum', () => {
    const src = `int printf(const char*,...);
      int main(void){ int s = 0, i; for (i = 1; i <= 100; i++) s += i; printf("%d", s); return 0; }`;
    expect(exec(src).out).toBe('5050');
  });
  it('while loop with break/continue', () => {
    const src = `int printf(const char*,...);
      int main(void){ int i = 0, n = 0; while (1) { i++; if (i > 10) break; if (i % 2) continue; n += i; } printf("%d", n); return 0; }`;
    expect(exec(src).out).toBe('30');
  });
  it('recursion (factorial)', () => {
    const src = `int printf(const char*,...);
      int fact(int n){ return n <= 1 ? 1 : n * fact(n - 1); }
      int main(void){ printf("%d", fact(5)); return 0; }`;
    expect(exec(src).out).toBe('120');
  });
  it('switch statement with fallthrough', () => {
    const src = `int printf(const char*,...);
      int main(void){ int x = 2; switch (x) { case 1: printf("a"); case 2: printf("b"); case 3: printf("c"); break; default: printf("d"); } return 0; }`;
    expect(exec(src).out).toBe('bc');
  });
  it('goto', () => {
    const src = `int printf(const char*,...);
      int main(void){ int i = 0; loop: printf("%d", i); i++; if (i < 3) goto loop; return 0; }`;
    expect(exec(src).out).toBe('012');
  });
});

describe('pointers, arrays, strings', () => {
  it('pointer arithmetic and dereference', () => {
    const src = `int printf(const char*,...);
      int main(void){ int a[3]; a[0]=10; a[1]=20; a[2]=30; int *p = a; printf("%d", *(p+1) + p[2]); return 0; }`;
    expect(exec(src).out).toBe('50');
  });
  it('string reverse in place', () => {
    const src = `int printf(const char*,...); unsigned long strlen(const char*);
      void rev(char *s){ int n = strlen(s), i; for (i = 0; i < n/2; i++){ char t = s[i]; s[i] = s[n-1-i]; s[n-1-i] = t; } }
      int main(void){ char s[] = "hello"; rev(s); printf("%s", s); return 0; }`;
    expect(exec(src).out).toBe('olleh');
  });
  it('pointer to function', () => {
    const src = `int printf(const char*,...);
      int add(int a, int b){ return a + b; }
      int main(void){ int (*fp)(int,int) = add; printf("%d", fp(3, 4)); return 0; }`;
    expect(exec(src).out).toBe('7');
  });
});

describe('structs & memory', () => {
  it('struct field access', () => {
    const src = `int printf(const char*,...);
      struct Point { int x, y; };
      int main(void){ struct Point p; p.x = 3; p.y = 4; printf("%d", p.x*p.x + p.y*p.y); return 0; }`;
    expect(exec(src).out).toBe('25');
  });
  it('struct pointer with arrow', () => {
    const src = `int printf(const char*,...);
      struct Node { int v; struct Node *next; };
      int main(void){ struct Node b, a; b.v = 2; b.next = 0; a.v = 1; a.next = &b; printf("%d", a.next->v); return 0; }`;
    expect(exec(src).out).toBe('2');
  });
  it('malloc / free round-trip', () => {
    const src = `int printf(const char*,...); void *malloc(unsigned long); void free(void*);
      int main(void){ int *p = malloc(4 * sizeof(int)); int i, s = 0; for (i=0;i<4;i++) p[i]=i*i; for (i=0;i<4;i++) s+=p[i]; free(p); printf("%d", s); return 0; }`;
    expect(exec(src).out).toBe('14');
  });
});

describe('globals & statics', () => {
  it('initialized global and static counter', () => {
    const src = `int printf(const char*,...);
      int g = 100;
      int next(void){ static int c = 0; return ++c; }
      int main(void){ printf("%d %d %d %d", g, next(), next(), next()); return 0; }`;
    expect(exec(src).out).toBe('100 1 2 3');
  });
  it('global array initializer', () => {
    const src = `int printf(const char*,...);
      int primes[] = {2, 3, 5, 7, 11};
      int main(void){ int i, s = 0; for (i = 0; i < 5; i++) s += primes[i]; printf("%d", s); return 0; }`;
    expect(exec(src).out).toBe('28');
  });
});

describe('stdlib', () => {
  it('qsort', () => {
    const src = `int printf(const char*,...); void qsort(void*, unsigned long, unsigned long, int(*)(const void*, const void*));
      int cmp(const void *a, const void *b){ return *(const int*)a - *(const int*)b; }
      int main(void){ int a[5] = {5, 2, 8, 1, 9}; qsort(a, 5, sizeof(int), cmp); int i; for (i=0;i<5;i++) printf("%d", a[i]); return 0; }`;
    expect(exec(src).out).toBe('12589');
  });
  it('atoi and abs', () => {
    const src = `int printf(const char*,...); int atoi(const char*); int abs(int);
      int main(void){ printf("%d %d", atoi("-42") , abs(-7)); return 0; }`;
    expect(exec(src).out).toBe('-42 7');
  });
});

describe('the sandbox catches faults', () => {
  it('reports a use-after-free', () => {
    const src = `void *malloc(unsigned long); void free(void*);
      int main(void){ int *p = malloc(4); free(p); *p = 5; return 0; }`;
    const r = exec(src);
    expect(r.err).toContain('use-after-free');
  });
  it('reports a null dereference', () => {
    const src = `int main(void){ int *p = 0; return *p; }`;
    expect(exec(src).err).toContain('null-deref');
  });
  it('detects a leak', () => {
    const src = `void *malloc(unsigned long); int main(void){ malloc(32); return 0; }`;
    const { tokens } = preprocess(src);
    const { unit } = parse(tokens);
    const sema = analyze(unit);
    const res = run(unit, sema, { natives: createLibc() });
    expect(res.leaks.length).toBe(1);
    expect(res.leaks[0]!.size).toBe(32);
  });
});
