import { describe, it, expect } from 'vitest';
import { compileAndRun } from './driver';

function runC(main: string, opts: { files?: Record<string, string>; stdin?: string; argv?: string[] } = {}) {
  const files = { 'main.c': main, ...(opts.files ?? {}) };
  const r = compileAndRun({ files, stdin: opts.stdin, argv: opts.argv });
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  return { out: r.stdout, err: r.stderr, code: r.result?.exitCode, errors: errors.map((e) => e.message) };
}

describe('standard headers', () => {
  it('compiles a program using <stdio.h> cleanly', () => {
    const r = runC('#include <stdio.h>\nint main(void){ printf("hi %d\\n", 5); return 0; }');
    expect(r.errors).toEqual([]);
    expect(r.out).toBe('hi 5\n');
  });
  it('uses <stdlib.h> and <string.h>', () => {
    const src = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void){
  char *s = malloc(16);
  strcpy(s, "abc");
  strcat(s, "def");
  printf("%s %lu\\n", s, (unsigned long)strlen(s));
  free(s);
  return 0;
}`;
    const r = runC(src);
    expect(r.errors).toEqual([]);
    expect(r.out).toBe('abcdef 6\n');
  });
  it('uses <ctype.h>', () => {
    const src = `#include <stdio.h>
#include <ctype.h>
int main(void){
  char *s = "Hello, World! 123";
  int i, letters = 0, digits = 0;
  for (i = 0; s[i]; i++){ if (isalpha(s[i])) letters++; if (isdigit(s[i])) digits++; }
  printf("%d %d\\n", letters, digits);
  return 0;
}`;
    expect(runC(src).out).toBe('10 3\n');
  });
  it('uses <math.h>', () => {
    const src = `#include <stdio.h>
#include <math.h>
int main(void){ printf("%.0f %.0f\\n", sqrt(144.0), pow(2.0, 10.0)); return 0; }`;
    expect(runC(src).out).toBe('12 1024\n');
  });
  it('assert() passes silently and fires on failure', () => {
    const ok = runC('#include <assert.h>\nint main(void){ assert(1 == 1); return 0; }');
    expect(ok.code).toBe(0);
    const bad = runC('#include <assert.h>\nint main(void){ assert(2 == 3); return 0; }');
    expect(bad.err).toContain('Assertion failed');
  });
});

describe('formatted input (scanf)', () => {
  it('reads integers with scanf', () => {
    const src = `#include <stdio.h>
int main(void){ int a, b; scanf("%d %d", &a, &b); printf("%d", a + b); return 0; }`;
    expect(runC(src, { stdin: '17 25' }).out).toBe('42');
  });
  it('sscanf parses a string', () => {
    const src = `#include <stdio.h>
int main(void){ int y, m, d; sscanf("2026-08-14", "%d-%d-%d", &y, &m, &d); printf("%d/%d/%d", d, m, y); return 0; }`;
    expect(runC(src).out).toBe('14/8/2026');
  });
  it('reads a word and a float', () => {
    const src = `#include <stdio.h>
int main(void){ char name[32]; double x; scanf("%s %lf", name, &x); printf("%s=%.1f", name, x); return 0; }`;
    expect(runC(src, { stdin: 'pi 3.14' }).out).toBe('pi=3.1');
  });
});

describe('file streams over the VFS', () => {
  it('writes then reads a file back', () => {
    const src = `#include <stdio.h>
int main(void){
  FILE *f = fopen("data.txt", "w");
  fprintf(f, "line %d\\n", 1);
  fputs("second\\n", f);
  fclose(f);
  f = fopen("data.txt", "r");
  char buf[64];
  while (fgets(buf, sizeof(buf), f)) printf("[%s]", buf);
  fclose(f);
  return 0;
}`;
    expect(runC(src).out).toBe('[line 1\n][second\n]');
  });
  it('fread/fwrite binary round-trip', () => {
    const src = `#include <stdio.h>
int main(void){
  int a[3] = {10, 20, 30};
  FILE *f = fopen("nums.bin", "w");
  fwrite(a, sizeof(int), 3, f);
  fclose(f);
  int b[3];
  f = fopen("nums.bin", "r");
  fread(b, sizeof(int), 3, f);
  fclose(f);
  printf("%d %d %d", b[0], b[1], b[2]);
  return 0;
}`;
    expect(runC(src).out).toBe('10 20 30');
  });
});

describe('multi-file compilation', () => {
  it('links a function defined in another .c file', () => {
    const files = {
      'util.c': 'int square(int x){ return x * x; }',
      'util.h': '#ifndef UTIL_H\n#define UTIL_H\nint square(int);\n#endif',
    };
    const main = `#include <stdio.h>
#include "util.h"
int main(void){ printf("%d", square(9)); return 0; }`;
    expect(runC(main, { files }).out).toBe('81');
  });
  it('shares a global across files', () => {
    const files = { 'counter.c': 'int counter = 0;\nvoid bump(void){ counter++; }' };
    const main = `#include <stdio.h>
extern int counter;
void bump(void);
int main(void){ bump(); bump(); bump(); printf("%d", counter); return 0; }`;
    expect(runC(main, { files }).out).toBe('3');
  });
});

describe('command-line arguments', () => {
  it('sees argc and argv', () => {
    const src = `#include <stdio.h>
int main(int argc, char **argv){ int i; printf("%d:", argc); for (i = 0; i < argc; i++) printf("%s,", argv[i]); return 0; }`;
    expect(runC(src, { argv: ['prog', 'a', 'b'] }).out).toBe('3:prog,a,b,');
  });
});
