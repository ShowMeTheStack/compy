/**
 * A corpus of small, deterministic C89 programs used for differential testing
 * against clang. Each program is written in clean C89 with no address-dependent
 * or uninitialized output, so clang and the interpreter must agree exactly.
 */
export interface CorpusProgram {
  name: string;
  source: string;
  stdin?: string;
}

export const CORPUS: CorpusProgram[] = [
  {
    name: 'arithmetic',
    source: `#include <stdio.h>
int main(void){
  int a = 17, b = 5;
  printf("%d %d %d %d %d\\n", a+b, a-b, a*b, a/b, a%b);
  printf("%d %d %d\\n", a<<2, a>>1, a^b);
  return 0;
}`,
  },
  {
    name: 'integer-overflow-wrap',
    source: `#include <stdio.h>
int main(void){
  unsigned int u = 4000000000u;
  u = u + 1000000000u;
  printf("%u\\n", u);
  { int i = 2000000000; i = i + i; printf("%d\\n", i); }
  return 0;
}`,
  },
  {
    name: 'float-formatting',
    source: `#include <stdio.h>
int main(void){
  double x = 355.0 / 113.0;
  printf("%.6f %.2f %.0f\\n", x, x, x);
  printf("%e\\n", 12345.678);
  printf("%g %g\\n", 0.0001, 100000.0);
  return 0;
}`,
  },
  {
    name: 'for-loops-sum',
    source: `#include <stdio.h>
int main(void){
  long sum = 0; int i;
  for (i = 1; i <= 1000; i++) sum += i;
  printf("%ld\\n", sum);
  return 0;
}`,
  },
  {
    name: 'nested-loops-primes',
    source: `#include <stdio.h>
int main(void){
  int n, d, count = 0;
  for (n = 2; n < 50; n++){
    int prime = 1;
    for (d = 2; d * d <= n; d++) if (n % d == 0){ prime = 0; break; }
    if (prime){ printf("%d ", n); count++; }
  }
  printf("\\ncount=%d\\n", count);
  return 0;
}`,
  },
  {
    name: 'recursion-fib',
    source: `#include <stdio.h>
int fib(int n){ return n < 2 ? n : fib(n-1) + fib(n-2); }
int main(void){
  int i;
  for (i = 0; i < 15; i++) printf("%d ", fib(i));
  printf("\\n");
  return 0;
}`,
  },
  {
    name: 'recursion-ackermann',
    source: `#include <stdio.h>
int ack(int m, int n){
  if (m == 0) return n + 1;
  if (n == 0) return ack(m - 1, 1);
  return ack(m - 1, ack(m, n - 1));
}
int main(void){ printf("%d\\n", ack(2, 3)); return 0; }`,
  },
  {
    name: 'pointers-swap',
    source: `#include <stdio.h>
void swap(int *a, int *b){ int t = *a; *a = *b; *b = t; }
int main(void){
  int x = 3, y = 7;
  swap(&x, &y);
  printf("%d %d\\n", x, y);
  return 0;
}`,
  },
  {
    name: 'arrays-reverse',
    source: `#include <stdio.h>
int main(void){
  int a[10]; int i;
  for (i = 0; i < 10; i++) a[i] = i * i;
  for (i = 0; i < 5; i++){ int t = a[i]; a[i] = a[9-i]; a[9-i] = t; }
  for (i = 0; i < 10; i++) printf("%d ", a[i]);
  printf("\\n");
  return 0;
}`,
  },
  {
    name: 'strings-manual',
    source: `#include <stdio.h>
int mystrlen(const char *s){ int n = 0; while (*s++) n++; return n; }
int main(void){
  const char *msg = "hello, world";
  printf("%d\\n", mystrlen(msg));
  { int i; for (i = 0; msg[i]; i++) putchar(msg[i] - 32 * (msg[i] >= 'a' && msg[i] <= 'z')); }
  printf("\\n");
  return 0;
}`,
  },
  {
    name: 'string-library',
    source: `#include <stdio.h>
#include <string.h>
int main(void){
  char buf[64];
  strcpy(buf, "foo");
  strcat(buf, "bar");
  printf("%s %d %d\\n", buf, (int)strlen(buf), strcmp("abc", "abd"));
  return 0;
}`,
  },
  {
    name: 'structs',
    source: `#include <stdio.h>
struct Point { int x, y; };
int dot(struct Point a, struct Point b){ return a.x*b.x + a.y*b.y; }
int main(void){
  struct Point p, q;
  p.x = 1; p.y = 2; q.x = 3; q.y = 4;
  printf("%d\\n", dot(p, q));
  return 0;
}`,
  },
  {
    name: 'malloc-array',
    source: `#include <stdio.h>
#include <stdlib.h>
int main(void){
  int n = 20, i; long sum = 0;
  int *a = (int*)malloc(n * sizeof(int));
  for (i = 0; i < n; i++) a[i] = i * 3 - 5;
  for (i = 0; i < n; i++) sum += a[i];
  printf("%ld\\n", sum);
  free(a);
  return 0;
}`,
  },
  {
    name: 'qsort-ints',
    source: `#include <stdio.h>
#include <stdlib.h>
int cmp(const void *a, const void *b){ return *(const int*)a - *(const int*)b; }
int main(void){
  int a[8]; int i;
  a[0]=5; a[1]=3; a[2]=8; a[3]=1; a[4]=9; a[5]=2; a[6]=7; a[7]=4;
  qsort(a, 8, sizeof(int), cmp);
  for (i = 0; i < 8; i++) printf("%d", a[i]);
  printf("\\n");
  return 0;
}`,
  },
  {
    name: 'switch-fallthrough',
    source: `#include <stdio.h>
int main(void){
  int i;
  for (i = 0; i < 6; i++){
    switch (i){
      case 0: case 1: printf("lo "); break;
      case 2: printf("two ");
      case 3: printf("three "); break;
      default: printf("hi ");
    }
  }
  printf("\\n");
  return 0;
}`,
  },
  {
    name: 'bitwise-popcount',
    source: `#include <stdio.h>
int popcount(unsigned x){ int c = 0; while (x){ c += x & 1; x >>= 1; } return c; }
int main(void){
  unsigned i;
  for (i = 0; i < 16; i++) printf("%d ", popcount(i));
  printf("\\n");
  return 0;
}`,
  },
  {
    name: 'enum-and-const',
    source: `#include <stdio.h>
enum Day { MON, TUE, WED, THU, FRI, SAT, SUN };
int main(void){
  enum Day d = WED;
  int week[7]; int i;
  for (i = 0; i < 7; i++) week[i] = i * i;
  printf("%d %d\\n", (int)d, week[d]);
  return 0;
}`,
  },
  {
    name: 'function-pointers',
    source: `#include <stdio.h>
int add(int a, int b){ return a + b; }
int mul(int a, int b){ return a * b; }
int apply(int (*f)(int,int), int a, int b){ return f(a, b); }
int main(void){
  printf("%d %d\\n", apply(add, 6, 7), apply(mul, 6, 7));
  return 0;
}`,
  },
  {
    name: 'scanf-sum',
    source: `#include <stdio.h>
int main(void){
  int a, b, c;
  scanf("%d %d %d", &a, &b, &c);
  printf("%d\\n", a + b + c);
  return 0;
}`,
    stdin: '11 22 33',
  },
  {
    name: 'matrix-multiply',
    source: `#include <stdio.h>
int main(void){
  int A[2][2], B[2][2], C[2][2]; int i, j, k;
  A[0][0]=1; A[0][1]=2; A[1][0]=3; A[1][1]=4;
  B[0][0]=5; B[0][1]=6; B[1][0]=7; B[1][1]=8;
  for (i = 0; i < 2; i++) for (j = 0; j < 2; j++){
    C[i][j] = 0;
    for (k = 0; k < 2; k++) C[i][j] += A[i][k] * B[k][j];
  }
  for (i = 0; i < 2; i++) for (j = 0; j < 2; j++) printf("%d ", C[i][j]);
  printf("\\n");
  return 0;
}`,
  },
];
