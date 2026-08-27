import { describe, it, expect } from 'vitest';
import { compileAndRun } from './driver';
import { lowerSource, runModule } from '../../ir/src/harness';
import { optimize } from '@compy/ir';

/** The libc functions added after M6, checked on the tree-walker and the IR engine. */
function both(src: string): string {
  const a = compileAndRun({ files: { 'main.c': src }, argv: ['prog'] });
  const errs = a.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
  expect(errs).toEqual([]);
  const { module } = lowerSource(src);
  const b = runModule(optimize(module).module, { 'main.c': src });
  expect(b.stdout).toBe(a.stdout);
  return a.stdout;
}

describe('libc extras', () => {
  it('strtol / strtoul / strtod with end pointers', () => {
    const out = both(`#include <stdio.h>
#include <stdlib.h>
int main(void){
  char *end;
  long a = strtol("  -42xyz", &end, 10);
  unsigned long b = strtoul("0xffFF", 0, 0);
  long c = strtol("0777", 0, 0);
  double d = strtod("3.5e2rest", &end);
  printf("%ld %s %lu %ld %.1f %s\\n", a, end, b, c, d, end);
  return 0;
}`);
    expect(out).toBe('-42 rest 65535 511 350.0 rest\n');
  });
  it('strtok tokenizes in place', () => {
    const out = both(`#include <stdio.h>
#include <string.h>
int main(void){
  char s[] = "a,b;;c";
  char *t = strtok(s, ",;");
  while (t) { printf("[%s]", t); t = strtok(0, ",;"); }
  printf("\\n");
  return 0;
}`);
    expect(out).toBe('[a][b][c]\n');
  });
  it('strrchr, strncat, strspn, strcspn, strpbrk, strdup, memchr', () => {
    const out = both(`#include <stdio.h>
#include <string.h>
#include <stdlib.h>
int main(void){
  char buf[32] = "hello";
  char *dup = strdup("abc.def.ghi");
  strncat(buf, " world!!!", 6);
  printf("%s|%s|%d|%d|%s|%s\\n", buf, strrchr(dup, '.'), (int)strspn("aabbc", "ab"), (int)strcspn("xyz;q", ";"), strpbrk("hello", "lo"), (char*)memchr("abcdef", 'd', 6));
  free(dup);
  return 0;
}`);
    expect(out).toBe('hello world|.ghi|4|3|llo|def\n');
  });
  it('bsearch and div', () => {
    const out = both(`#include <stdio.h>
#include <stdlib.h>
int cmp(const void *a, const void *b){ return *(const int*)a - *(const int*)b; }
int main(void){
  int v[] = {1, 3, 5, 7, 9, 11};
  int key = 7, miss = 4;
  int *p = bsearch(&key, v, 6, sizeof(int), cmp);
  int *q = bsearch(&miss, v, 6, sizeof(int), cmp);
  div_t d = div(17, 5);
  printf("%d %d %d %d\\n", p ? (int)(p - v) : -1, q ? 1 : 0, d.quot, d.rem);
  return 0;
}`);
    expect(out).toBe('3 0 3 2\n');
  });
  it('math extras and gmtime', () => {
    const out = both(`#include <stdio.h>
#include <math.h>
#include <time.h>
int main(void){
  int e; double m = frexp(48.0, &e), ip, fr = modf(3.75, &ip);
  time_t t = 86400 * 365;
  struct tm *tm = gmtime(&t);
  char buf[32];
  strftime(buf, sizeof buf, "%Y-%m-%d %H:%M", tm);
  printf("%.2f %d %.2f %.2f %.3f %s\\n", m, e, ip, fr, atan2(1.0, 1.0), buf);
  return 0;
}`);
    expect(out).toBe('0.75 6 3.00 0.75 0.785 1971-01-01 00:00\n');
  });
  it('sizeof(struct T) by type name is right everywhere', () => {
    const out = both(`#include <stdio.h>
struct P { char c; int i; short s; };
struct Node { int v; struct Node *next; };
int main(void){ printf("%d %d %d\\n", (int)sizeof(struct P), (int)sizeof(struct Node), (int)sizeof(struct Node *)); return 0; }`);
    expect(out).toBe('12 8 4\n');
  });
});
