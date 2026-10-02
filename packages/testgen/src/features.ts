/**
 * One small program per C89 feature, each with its exact expected output.
 * They are checked against clang (where available) and the tree-walker in
 * the unit suite, and driven through the IDE on all three engines by the
 * end-to-end suite.
 */
export interface FeatureProgram {
  name: string;
  area: string;
  source: string;
  expected: string;
  stdin?: string;
  /** Deliberate bug: the sandbox must report this fault kind. */
  fault?: string;
  /** Output depends on the ILP32 model, so the host clang (LP64) disagrees. */
  noClang?: boolean;
}

const H = '#include <stdio.h>\n';

export const FEATURES: FeatureProgram[] = [
  { name: 'int-arithmetic', area: 'expressions', source: H + `int main(void){ int a=7,b=2; printf("%d %d %d %d %d\\n", a+b, a-b, a*b, a/b, a%b); return 0; }`, expected: '9 5 14 3 1\n' },
  { name: 'negative-division', area: 'expressions', source: H + `int main(void){ printf("%d %d %d %d\\n", -7/2, -7%2, 7/-2, 7%-2); return 0; }`, expected: '-3 -1 -3 1\n' },
  { name: 'precedence', area: 'expressions', source: H + `int main(void){ printf("%d %d %d\\n", 2+3*4, (2+3)*4, 10-4-3); return 0; }`, expected: '14 20 3\n' },
  { name: 'shifts-and-bitwise', area: 'expressions', source: H + `int main(void){ unsigned x=0xF0; printf("%u %u %u %u %u %u\\n", x<<2, x>>4, x&0x3C, x|0x0F, x^0xFF, ~x&0xFF); return 0; }`, expected: '960 15 48 255 15 15\n' },
  { name: 'logical-short-circuit', area: 'expressions', source: H + `int n=0; int f(void){ n++; return 1; }\nint main(void){ int a = 0 && f(); int b = 1 || f(); int c = f() && f(); printf("%d %d %d %d\\n", a, b, c, n); return 0; }`, expected: '0 1 1 2\n' },
  { name: 'ternary-and-comma', area: 'expressions', source: H + `int main(void){ int x=5, y; y = (x>3 ? 10 : 20); x = (y++, y+1); printf("%d %d\\n", x, y); return 0; }`, expected: '12 11\n' },
  { name: 'compound-assignment', area: 'expressions', source: H + `int main(void){ int a=10; a+=5; a-=3; a*=2; a/=4; a%=5; a<<=2; a>>=1; a|=8; a&=12; a^=5; printf("%d\\n", a); return 0; }`, expected: '13\n' },
  { name: 'increment-decrement', area: 'expressions', source: H + `int main(void){ int i=5, a, b; a = i++; b = ++i; printf("%d %d %d\\n", a, b, i); a = i--; b = --i; printf("%d %d %d\\n", a, b, i); return 0; }`, expected: '5 7 7\n7 5 5\n' },
  { name: 'char-arithmetic', area: 'types', source: H + `int main(void){ char c='a'; c += 2; printf("%c %d %c\\n", c, c, 'Z'-1); return 0; }`, expected: 'c 99 Y\n' },
  { name: 'unsigned-wraparound', area: 'types', source: H + `int main(void){ unsigned char u=250; unsigned int w=0; u += 10; w -= 1; printf("%u %u\\n", u, w); return 0; }`, expected: '4 4294967295\n' },
  { name: 'integer-widths', area: 'types', source: H + `int main(void){ printf("%d %d %d %d %d\\n", (int)sizeof(char), (int)sizeof(short), (int)sizeof(int), (int)sizeof(long), (int)sizeof(long long)); return 0; }`, expected: '1 2 4 4 8\n', noClang: true },
  { name: 'short-and-long', area: 'types', source: H + `int main(void){ short s=32767; long l=2147483647L; s++; printf("%d %ld\\n", s, l); return 0; }`, expected: '-32768 2147483647\n' },
  { name: 'long-long', area: 'types', source: H + `int main(void){ long long a = 4000000000LL; long long b = a * 3; printf("%lld %lld %lld\\n", a, b, b / 7); return 0; }`, expected: '4000000000 12000000000 1714285714\n' },
  { name: 'float-vs-double', area: 'types', source: H + `int main(void){ float f = 1.0f/3.0f; double d = 1.0/3.0; printf("%.7f %.15f\\n", f, d); return 0; }`, expected: '0.3333333 0.333333333333333\n' },
  { name: 'float-formats', area: 'stdio', source: H + `int main(void){ double x = 1234.5678; printf("%f|%.2f|%8.1f|%-8.1f|%e|%g\\n", x, x, x, x, x, x); return 0; }`, expected: '1234.567800|1234.57|  1234.6|1234.6  |1.234568e+03|1234.57\n' },
  { name: 'int-formats', area: 'stdio', source: H + `int main(void){ int n=42; printf("[%d][%5d][%-5d][%05d][%x][%X][%o][%+d][%c]\\n", n, n, n, n, 255, 255, 8, n, 65); return 0; }`, expected: '[42][   42][42   ][00042][ff][FF][10][+42][A]\n' },
  { name: 'string-formats', area: 'stdio', source: H + `int main(void){ printf("[%s][%10s][%-10s][%.3s]\\n", "hi", "hi", "hi", "hello"); return 0; }`, expected: '[hi][        hi][hi        ][hel]\n' },
  { name: 'casts', area: 'types', source: H + `int main(void){ double d = 3.99; int i = (int)d; char c = (char)300; unsigned u = (unsigned)-1; printf("%d %d %u %.1f\\n", i, c, u, (double)i/2); return 0; }`, expected: '3 44 4294967295 1.5\n' },
  { name: 'implicit-conversions', area: 'types', source: H + `int main(void){ int i = 7; double d = i / 2; double e = i / 2.0; printf("%.1f %.1f %d\\n", d, e, (int)(e * 2)); return 0; }`, expected: '3.0 3.5 7\n' },
  { name: 'if-else-chain', area: 'control', source: H + `int main(void){ int i; for (i = 0; i < 6; i++) { if (i < 2) printf("a"); else if (i < 4) printf("b"); else printf("c"); } printf("\\n"); return 0; }`, expected: 'aabbcc\n' },
  { name: 'while-break-continue', area: 'control', source: H + `int main(void){ int i = 0, s = 0; while (1) { i++; if (i % 2) continue; if (i > 10) break; s += i; } printf("%d %d\\n", i, s); return 0; }`, expected: '12 30\n' },
  { name: 'do-while', area: 'control', source: H + `int main(void){ int i = 10, n = 0; do { n++; i -= 3; } while (i > 0); printf("%d %d\\n", n, i); return 0; }`, expected: '4 -2\n' },
  { name: 'nested-for', area: 'control', source: H + `int main(void){ int i, j; for (i = 1; i <= 3; i++) { for (j = 1; j <= i; j++) printf("%d", j); printf("\\n"); } return 0; }`, expected: '1\n12\n123\n' },
  { name: 'switch-fallthrough', area: 'control', source: H + `int main(void){ int d; for (d = 0; d < 5; d++) { switch (d) { case 0: printf("zero "); break; case 1: case 2: printf("small "); break; case 3: printf("three "); default: printf("other "); } } printf("\\n"); return 0; }`, expected: 'zero small small three other other \n' },
  { name: 'goto', area: 'control', source: H + `int main(void){ int i = 0; loop: if (i < 3) { printf("%d", i); i++; goto loop; } printf("\\n"); return 0; }`, expected: '012\n' },
  { name: 'functions-and-prototypes', area: 'functions', source: H + `int sq(int); static int cube(int x){ return x * sq(x); }\nint sq(int x){ return x * x; }\nint main(void){ printf("%d %d\\n", sq(5), cube(3)); return 0; }`, expected: '25 27\n' },
  { name: 'recursion-fib', area: 'functions', source: H + `int fib(int n){ return n < 2 ? n : fib(n-1) + fib(n-2); }\nint main(void){ int i; for (i = 0; i < 10; i++) printf("%d ", fib(i)); printf("\\n"); return 0; }`, expected: '0 1 1 2 3 5 8 13 21 34 \n' },
  { name: 'pass-by-value-vs-pointer', area: 'functions', source: H + `void byval(int x){ x = 99; } void byptr(int *x){ *x = 99; }\nint main(void){ int a = 1, b = 1; byval(a); byptr(&b); printf("%d %d\\n", a, b); return 0; }`, expected: '1 99\n' },
  { name: 'static-local', area: 'functions', source: H + `int counter(void){ static int c = 0; return ++c; }\nint main(void){ counter(); counter(); printf("%d\\n", counter()); return 0; }`, expected: '3\n' },
  { name: 'function-pointers', area: 'functions', source: H + `int add(int a, int b){ return a+b; } int mul(int a, int b){ return a*b; }\nint main(void){ int (*ops[2])(int,int) = { add, mul }; int (*f)(int,int) = ops[1]; printf("%d %d\\n", ops[0](2,3), f(2,3)); return 0; }`, expected: '5 6\n' },
  { name: 'variadic-printf-args', area: 'functions', source: H + `int main(void){ char c = 'x'; short s = 3; float f = 2.5f; printf("%c %d %.1f %d\\n", c, s, f, (int)sizeof(int)); return 0; }`, expected: 'x 3 2.5 4\n' },
  { name: 'arrays-1d', area: 'arrays', source: H + `int main(void){ int a[5] = {1, 2, 3}; int i, s = 0; for (i = 0; i < 5; i++) s += a[i]; printf("%d %d %d\\n", s, a[4], (int)(sizeof a / sizeof a[0])); return 0; }`, expected: '6 0 5\n' },
  { name: 'arrays-2d', area: 'arrays', source: H + `int main(void){ int m[2][3] = {{1,2,3},{4,5,6}}; int i, j, s = 0; for (i = 0; i < 2; i++) for (j = 0; j < 3; j++) s += m[i][j] * (i+1); printf("%d %d\\n", s, m[1][2]); return 0; }`, expected: '36 6\n' },
  { name: 'array-decay-and-pointer-arith', area: 'pointers', source: H + `int main(void){ int a[4] = {10, 20, 30, 40}; int *p = a; p += 2; printf("%d %d %d %d\\n", *p, p[1], *(a + 1), (int)(p - a)); return 0; }`, expected: '30 40 20 2\n' },
  { name: 'pointer-to-pointer', area: 'pointers', source: H + `int main(void){ int x = 5; int *p = &x; int **pp = &p; **pp = 8; printf("%d %d\\n", x, *p == **pp); return 0; }`, expected: '8 1\n' },
  { name: 'array-of-strings', area: 'pointers', source: H + `int main(void){ const char *names[] = {"ann", "bob", "cy"}; int i; for (i = 0; i < 3; i++) printf("%s:%d ", names[i], (int)(names[i][0])); printf("\\n"); return 0; }`, expected: 'ann:97 bob:98 cy:99 \n' },
  { name: 'void-pointer-and-null', area: 'pointers', source: H + `int main(void){ int x = 3; void *v = &x; int *p = (int *)v; int *q = NULL; printf("%d %d %d\\n", *p, q == NULL, p != 0); return 0; }`, expected: '3 1 1\n' },
  { name: 'strings-and-string-h', area: 'strings', source: H + `#include <string.h>\nint main(void){ char s[32] = "hello"; strcat(s, ", "); strcat(s, "world"); printf("%s %d %d %c\\n", s, (int)strlen(s), strcmp("abc", "abd") < 0, s[7]); return 0; }`, expected: 'hello, world 12 1 w\n' },
  { name: 'string-manual-reverse', area: 'strings', source: H + `int main(void){ char s[] = "stressed"; int i = 0, j = 7; while (i < j) { char t = s[i]; s[i++] = s[j]; s[j--] = t; } printf("%s\\n", s); return 0; }`, expected: 'desserts\n' },
  { name: 'sprintf-sscanf', area: 'stdio', source: H + `int main(void){ char buf[32]; int a, b; sprintf(buf, "%d-%d", 12, 34); sscanf(buf, "%d-%d", &a, &b); printf("%s %d\\n", buf, a + b); return 0; }`, expected: '12-34 46\n' },
  { name: 'scanf-stdin', area: 'stdio', source: H + `int main(void){ int a, b; char w[16]; scanf("%d %d %s", &a, &b, w); printf("%d %s\\n", a * b, w); return 0; }`, expected: '42 ok\n', stdin: '6 7 ok\n' },
  { name: 'getchar-loop', area: 'stdio', source: H + `int main(void){ int c, n = 0; while ((c = getchar()) != EOF) if (c == 'a') n++; printf("%d\\n", n); return 0; }`, expected: '3\n', stdin: 'banana' },
  { name: 'file-io', area: 'stdio', source: H + `int main(void){ FILE *f = fopen("t.txt", "w"); char line[32]; fprintf(f, "line one\\nline two\\n"); fclose(f); f = fopen("t.txt", "r"); fgets(line, 32, f); fgets(line, 32, f); fclose(f); printf("%s", line); return 0; }`, expected: 'line two\n' },
  { name: 'struct-basics', area: 'structs', source: H + `struct P { int x, y; };\nint main(void){ struct P p = {3, 4}, q; q = p; q.x = 10; printf("%d %d %d %d\\n", p.x, p.y, q.x, (int)sizeof(struct P)); return 0; }`, expected: '3 4 10 8\n' },
  { name: 'struct-pointer-arrow', area: 'structs', source: H + `struct Node { int v; struct Node *next; };\nint main(void){ struct Node b = {2, 0}, a = {1, &b}; struct Node *p = &a; int s = 0; while (p) { s += p->v; p = p->next; } printf("%d\\n", s); return 0; }`, expected: '3\n' },
  { name: 'struct-by-value-return', area: 'structs', source: H + `struct V { int a, b; };\nstruct V mk(int a, int b){ struct V v; v.a = a; v.b = b; return v; }\nint sum(struct V v){ return v.a + v.b; }\nint main(void){ struct V v = mk(2, 5); printf("%d %d\\n", sum(v), mk(1, 1).b); return 0; }`, expected: '7 1\n' },
  { name: 'nested-struct-and-array', area: 'structs', source: H + `struct In { int a[2]; }; struct Out { struct In in; char tag; };\nint main(void){ struct Out o = {{{7, 8}}, 'k'}; struct Out arr[2]; arr[1] = o; arr[1].in.a[0]++; printf("%d %d %c\\n", o.in.a[0], arr[1].in.a[0], arr[1].tag); return 0; }`, expected: '7 8 k\n' },
  { name: 'union', area: 'structs', source: H + `union U { int i; unsigned char b[4]; };\nint main(void){ union U u; u.i = 0x01020304; printf("%d %d %d\\n", u.b[0], u.b[3], (int)sizeof(union U)); return 0; }`, expected: '4 1 4\n' },
  { name: 'enum', area: 'types', source: H + `enum Color { RED, GREEN = 5, BLUE };\nint main(void){ enum Color c = BLUE; printf("%d %d %d %d\\n", RED, GREEN, c, c == BLUE); return 0; }`, expected: '0 5 6 1\n' },
  { name: 'typedef', area: 'types', source: H + `typedef unsigned char byte; typedef struct { byte r, g, b; } Pixel; typedef int (*Op)(int);\nint dbl(int x){ return 2 * x; }\nint main(void){ Pixel p = {255, 128, 0}; Op f = dbl; printf("%d %d %d %d\\n", p.r, p.g, f(21), (int)sizeof(Pixel)); return 0; }`, expected: '255 128 42 3\n' },
  { name: 'const-and-sizeof', area: 'types', source: H + `int main(void){ const int k = 10; const char *msg = "hi"; int arr[k > 5 ? 3 : 1]; printf("%d %s %d %d\\n", k, msg, (int)sizeof arr, (int)sizeof(double)); return 0; }`, expected: '10 hi 12 8\n' },
  { name: 'object-macros', area: 'preprocessor', source: H + `#define N 4\n#define DOUBLE_N (N * 2)\nint main(void){ int a[N]; printf("%d %d %d\\n", N, DOUBLE_N, (int)(sizeof a / sizeof a[0])); return 0; }`, expected: '4 8 4\n' },
  { name: 'function-macros-stringize-paste', area: 'preprocessor', source: H + `#define SQ(x) ((x) * (x))\n#define STR(x) #x\n#define CAT(a, b) a##b\nint main(void){ int xy = 7; printf("%d %s %d\\n", SQ(1 + 2), STR(hello world), CAT(x, y)); return 0; }`, expected: '9 hello world 7\n' },
  { name: 'conditional-compilation', area: 'preprocessor', source: H + `#define MODE 2\n#if MODE == 1\n#define NAME "one"\n#elif MODE == 2\n#define NAME "two"\n#else\n#define NAME "other"\n#endif\n#ifndef MISSING\n#define EXTRA 1\n#endif\nint main(void){ printf("%s %d\\n", NAME, EXTRA); return 0; }`, expected: 'two 1\n' },
  { name: 'multi-file-project', area: 'preprocessor', source: `#include <stdio.h>\n#include "util.h"\nint main(void){ printf("%d %d\\n", twice(21), LIMIT); return 0; }\n`, expected: '42 100\n' },
  { name: 'malloc-free', area: 'heap', source: H + `#include <stdlib.h>\nint main(void){ int *a = malloc(3 * sizeof(int)); int i, s = 0; for (i = 0; i < 3; i++) a[i] = i * 10; for (i = 0; i < 3; i++) s += a[i]; free(a); printf("%d\\n", s); return 0; }`, expected: '30\n' },
  { name: 'calloc-realloc', area: 'heap', source: H + `#include <stdlib.h>\nint main(void){ int *a = calloc(2, sizeof(int)); a[1] = 5; a = realloc(a, 4 * sizeof(int)); a[3] = 9; printf("%d %d %d\\n", a[0], a[1], a[3]); free(a); return 0; }`, expected: '0 5 9\n' },
  { name: 'qsort-and-bsearch', area: 'stdlib', source: H + `#include <stdlib.h>\nint cmp(const void *a, const void *b){ return *(const int*)a - *(const int*)b; }\nint main(void){ int v[6] = {9, 1, 8, 2, 7, 3}, key = 8, i; int *p; qsort(v, 6, sizeof(int), cmp); p = bsearch(&key, v, 6, sizeof(int), cmp); for (i = 0; i < 6; i++) printf("%d", v[i]); printf(" %d\\n", (int)(p - v)); return 0; }`, expected: '123789 4\n' },
  { name: 'atoi-strtol-abs', area: 'stdlib', source: H + `#include <stdlib.h>\nint main(void){ printf("%d %ld %d %ld\\n", atoi("  -17x"), strtol("ff", 0, 16), abs(-4), labs(-5L)); return 0; }`, expected: '-17 255 4 5\n' },
  { name: 'math-h', area: 'stdlib', source: H + `#include <math.h>\nint main(void){ printf("%.3f %.1f %.1f %.1f %.3f\\n", sqrt(2.0), pow(2.0, 10.0), floor(-2.5), ceil(2.1), fabs(-1.25)); return 0; }`, expected: '1.414 1024.0 -3.0 3.0 1.250\n' },
  { name: 'ctype-h', area: 'stdlib', source: H + `#include <ctype.h>\nint main(void){ char *s = "aB3 ."; int i, d = 0, al = 0, sp = 0; for (i = 0; s[i]; i++) { if (isdigit(s[i])) d++; if (isalpha(s[i])) al++; if (isspace(s[i])) sp++; } printf("%d %d %d %c %c\\n", d, al, sp, toupper('q'), tolower('Q')); return 0; }`, expected: '1 2 1 Q q\n' },
  { name: 'exit-code-and-exit', area: 'process', source: H + `#include <stdlib.h>\nint main(void){ printf("bye\\n"); exit(3); }`, expected: 'bye\n' },
  { name: 'assert-passes', area: 'process', source: H + `#include <assert.h>\nint main(void){ int x = 2; assert(x + x == 4); printf("ok\\n"); return 0; }`, expected: 'ok\n' },
  { name: 'vla', area: 'extras', source: H + `int main(void){ int n = 4, i, s = 0; int a[n]; for (i = 0; i < n; i++) a[i] = i + 1; for (i = 0; i < n; i++) s += a[i]; printf("%d\\n", s); return 0; }`, expected: '10\n' },
  { name: 'bool-and-mixed-decls', area: 'extras', source: H + `#include <stdbool.h>\nint main(void){ int i = 2; bool b = i > 1; // a C99-style comment\n for (int k = 0; k < 2; k++) i += k; printf("%d %d\\n", b, i); return 0; }`, expected: '1 3\n' },
  { name: 'bug-null-deref', area: 'bugs', source: H + `int main(void){ int *p = 0; printf("%d\\n", *p); return 0; }`, expected: '', fault: 'null-deref' },
  { name: 'bug-out-of-bounds', area: 'bugs', source: H + `#include <stdlib.h>\nint main(void){ int *a = malloc(2 * sizeof(int)); a[5] = 1; free(a); return 0; }`, expected: '', fault: 'out-of-bounds' },
  { name: 'bug-use-after-free', area: 'bugs', source: H + `#include <stdlib.h>\nint main(void){ int *a = malloc(4); *a = 1; free(a); printf("%d\\n", *a); return 0; }`, expected: '', fault: 'use-after-free' },
  { name: 'bug-double-free', area: 'bugs', source: H + `#include <stdlib.h>\nint main(void){ int *a = malloc(4); free(a); free(a); return 0; }`, expected: '', fault: 'double-free' },
  { name: 'bug-write-to-literal', area: 'bugs', source: H + `int main(void){ char *s = "const"; s[0] = 'C'; printf("%s\\n", s); return 0; }`, expected: '', fault: 'write-to-readonly' },
  { name: 'bug-leak', area: 'bugs', source: H + `#include <stdlib.h>\nint main(void){ int *a = malloc(16); a[0] = 1; printf("leaky\\n"); return 0; }`, expected: 'leaky\n', fault: 'leak' },
];

/** The header the multi-file feature program includes. */
export const FEATURE_EXTRA_FILES: Record<string, Record<string, string>> = {
  'multi-file-project': { 'util.h': '#define LIMIT 100\nint twice(int x);\n', 'util.c': '#include "util.h"\nint twice(int x){ return 2 * x; }\n' },
};
