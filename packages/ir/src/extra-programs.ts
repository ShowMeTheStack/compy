/** Programs that stress the parts of lowering the clang corpus does not. */
export const EXTRA_PROGRAMS: { name: string; source: string; stdin?: string }[] = [
  {
    name: 'short-circuit-and-ternary',
    source: `#include <stdio.h>
int calls = 0;
int t(int v){ calls++; return v; }
int main(void){
  int a = t(0) && t(1);
  int b = t(1) || t(0);
  int c = t(1) ? t(2) : t(3);
  printf("%d %d %d calls=%d\\n", a, b, c, calls);
  printf("%d\\n", !a + !!b);
  return 0;
}`,
  },
  {
    name: 'goto-and-labels',
    source: `#include <stdio.h>
int main(void){
  int i = 0;
again:
  if (i < 3) { printf("i=%d\\n", i); i++; goto again; }
  for (i = 0; i < 10; i++) { if (i == 4) goto done; }
done:
  printf("done %d\\n", i);
  return 0;
}`,
  },
  {
    name: 'structs-by-value',
    source: `#include <stdio.h>
struct P { int x, y; double w; };
struct P mk(int x, int y){ struct P p; p.x = x; p.y = y; p.w = x * 0.5; return p; }
int sum(struct P p){ p.x += 100; return p.x + p.y; }
int main(void){
  struct P a = mk(3, 4), b;
  b = a; b.y = 9;
  printf("%d %d %d %.1f %d\\n", sum(a), a.x, b.y, b.w, mk(1,2).y);
  { struct P arr[2] = { {1,2,3.0}, {4,5} }; printf("%d %.1f\\n", arr[1].y, arr[1].w); }
  return 0;
}`,
  },
  {
    name: 'nested-aggregates-init',
    source: `#include <stdio.h>
struct In { int a[3]; char name[8]; };
struct Out { struct In in; int k; };
struct Out g = { { {1,2,3}, "abc" }, 7 };
int tbl[2][3] = { {1,2,3}, {4} };
int main(void){
  struct Out l = { { {9}, "xy" }, 1 };
  int i, j;
  printf("%d %s %d | %d %s %d %d\\n", g.in.a[2], g.in.name, g.k, l.in.a[0], l.in.name, l.in.a[2], l.k);
  for (i = 0; i < 2; i++) for (j = 0; j < 3; j++) printf("%d ", tbl[i][j]);
  printf("\\n");
  return 0;
}`,
  },
  {
    name: 'compound-assign-and-incdec',
    source: `#include <stdio.h>
int main(void){
  int a = 5, b;
  unsigned u = 10;
  char c = 120;
  double d = 1.5;
  int *p; int arr[4] = {10,20,30,40};
  a += 3; a *= 2; a -= 1; a /= 3; a %= 4; a <<= 3; a >>= 1; a |= 1; a &= 7; a ^= 2;
  b = a++ + ++a;
  u -= 11;
  c += 10;
  d *= 2; d /= 4;
  p = arr; p++; *p += 1; p += 2; p--;
  printf("%d %d %u %d %.3f %d %d\\n", a, b, u, c, d, *p, (int)(p - arr));
  return 0;
}`,
  },
  {
    name: 'unsigned-and-long-long',
    source: `#include <stdio.h>
int main(void){
  unsigned char uc = 200; signed char sc = -56;
  unsigned short us = 65535; short ss = -1;
  unsigned int ui = 0xFFFFFFFFu;
  long long big = 1LL << 40; unsigned long long ub = 0xFFFFFFFFFFFFFFFFull;
  printf("%d %d %d %d\\n", uc, sc, us, ss);
  printf("%u %d %u\\n", ui, ui / 2u, ui >> 4);
  printf("%lld %lld %d\\n", big, big * 3 + 7, (int)(big >> 38));
  printf("%d %d\\n", (int)(ub >> 60), -1 < 0u);
  printf("%d %d\\n", (unsigned char)300, (char)-1 == -1);
  return 0;
}`,
  },
  {
    name: 'float-conversions',
    source: `#include <stdio.h>
int main(void){
  float f = 1.0f / 3.0f; double d = f; int i = -7; unsigned u = 4000000000u;
  double q = i / 2.0; int t = (int)-3.99; int r = 7 / 2;
  printf("%.7f %.3f %d %d %.1f\\n", d, (double)f * 3, t, r, q);
  printf("%.1f %.1f %d\\n", (double)u, (float)i, (int)(d * 100));
  printf("%d\\n", 2.5 > 2 && 2 == 2.0);
  return 0;
}`,
  },
  {
    name: 'function-pointers-and-callbacks',
    source: `#include <stdio.h>
#include <stdlib.h>
typedef int (*op)(int, int);
int add(int a, int b){ return a + b; }
int mul(int a, int b){ return a * b; }
int apply(op f, int x, int y){ return f(x, y); }
int cmp(const void *a, const void *b){ return *(const int*)a - *(const int*)b; }
int main(void){
  op table[2] = { add, mul };
  int v[5] = { 5, 1, 4, 2, 3 }, i;
  printf("%d %d %d\\n", apply(add, 2, 3), table[1](4, 5), (*table[0])(1, 1));
  qsort(v, 5, sizeof(int), cmp);
  for (i = 0; i < 5; i++) printf("%d", v[i]);
  printf("\\n");
  return 0;
}`,
  },
  {
    name: 'static-locals-and-globals',
    source: `#include <stdio.h>
int counter(void){ static int n = 10; return n++; }
static int hidden = 3;
int *gp = &hidden;
char *names[] = { "zero", "one", "two" };
int main(void){
  counter(); counter();
  printf("%d %d %s %s\\n", counter(), *gp, names[1], names[2] + 1);
  return 0;
}`,
  },
  {
    name: 'switch-nested-and-default-first',
    source: `#include <stdio.h>
const char *name(int d){
  switch (d) {
    default: return "many";
    case 0: return "zero";
    case 1: case 2: return "few";
  }
}
int main(void){
  int i, s = 0;
  for (i = -1; i < 5; i++) {
    switch (i) {
      case 1: s += 10; /* fallthrough */
      case 2: s += 1; break;
      case 3: { int k = i * 2; s += k; } break;
      case 4: continue;
      default: s -= 1;
    }
    printf("%s ", name(i));
  }
  printf("%d\\n", s);
  return 0;
}`,
  },
  {
    name: 'vla-and-strings',
    source: `#include <stdio.h>
#include <string.h>
int main(void){
  int n = 5, i, total = 0;
  int a[n];
  char buf[16] = "hello";
  char w[] = "wor";
  for (i = 0; i < n; i++) a[i] = i * i;
  for (i = 0; i < n; i++) total += a[i];
  strcat(buf, w);
  printf("%d %s %d %d\\n", total, buf, (int)sizeof(buf), (int)sizeof w);
  printf("%c %c %d\\n", buf[1], "xyz"[2], 'a' + 1);
  return 0;
}`,
  },
  {
    name: 'pointer-arith-and-2d',
    source: `#include <stdio.h>
int main(void){
  int m[3][4], i, j, *p = &m[0][0], (*row)[4] = m + 1;
  for (i = 0; i < 3; i++) for (j = 0; j < 4; j++) m[i][j] = i * 10 + j;
  printf("%d %d %d %d\\n", *(p + 5), row[1][2], (int)(&m[2][3] - p), (int)sizeof(m[0]));
  printf("%d %d\\n", 2[m][1], (*row)[3]);
  return 0;
}`,
  },
  {
    name: 'recursion-mutual-and-exit-code',
    source: `#include <stdio.h>
int odd(int n);
int even(int n){ return n == 0 ? 1 : odd(n - 1); }
int odd(int n){ return n == 0 ? 0 : even(n - 1); }
int main(void){
  printf("%d %d\\n", even(10), odd(7));
  return even(10) ? 42 : 0;
}`,
  },
  {
    name: 'uaf-is-caught',
    source: `#include <stdlib.h>
int main(void){ int *p = malloc(8); p[0] = 1; free(p); return p[0]; }`,
  },
  {
    name: 'do-while-and-while-break',
    source: `#include <stdio.h>
int main(void){
  int i = 0, n = 0;
  do { i++; if (i == 2) continue; n += i; } while (i < 5);
  while (1) { if (n-- < 10) break; }
  printf("%d %d\\n", i, n);
  return 0;
}`,
  },
  {
    name: 'bool-and-enum',
    source: `#include <stdio.h>
#include <stdbool.h>
enum Color { RED, GREEN = 5, BLUE };
int main(void){
  bool b = 7, c = 0;
  enum Color col = BLUE;
  b = b + 1;
  printf("%d %d %d %d %d\\n", b, c, !c, col, (int)sizeof(enum Color));
  return 0;
}`,
  },
];
