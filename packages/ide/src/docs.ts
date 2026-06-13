/**
 * Concise reference docs for core C concepts and library functions. Powers the
 * doc lookups in the offline assistant and (later) a docs tab. Every example is
 * runnable C89.
 */
export interface Doc {
  title: string;
  category: string;
  summary: string;
  syntax: string;
  example?: string;
}

export const DOCS: Record<string, Doc> = {
  printf: {
    title: 'printf',
    category: 'stdio.h',
    summary: 'Print formatted output to stdout. %d int, %f double, %s string, %c char, %x hex.',
    syntax: 'int printf(const char *format, ...);',
    example: `#include <stdio.h>\nint main(void){\n    printf("%d + %d = %d\\n", 2, 3, 2 + 3);\n    return 0;\n}`,
  },
  scanf: {
    title: 'scanf',
    category: 'stdio.h',
    summary: 'Read formatted input from stdin. Pass the ADDRESS of each variable with &.',
    syntax: 'int scanf(const char *format, ...);',
    example: `#include <stdio.h>\nint main(void){\n    int n;\n    scanf("%d", &n);\n    printf("you typed %d\\n", n);\n    return 0;\n}`,
  },
  for: {
    title: 'for loop',
    category: 'control flow',
    summary: 'Repeat with an initializer, a condition, and a step — best when you know the count.',
    syntax: 'for (init; condition; step) statement',
    example: `#include <stdio.h>\nint main(void){\n    int i;\n    for (i = 0; i < 5; i++) printf("%d ", i);\n    printf("\\n");\n    return 0;\n}`,
  },
  while: {
    title: 'while loop',
    category: 'control flow',
    summary: 'Repeat while a condition is true — best when the count is not known in advance.',
    syntax: 'while (condition) statement',
    example: `#include <stdio.h>\nint main(void){\n    int n = 8;\n    while (n > 1){ printf("%d ", n); n /= 2; }\n    printf("\\n");\n    return 0;\n}`,
  },
  if: {
    title: 'if / else',
    category: 'control flow',
    summary: 'Choose between paths based on a condition.',
    syntax: 'if (condition) statement else statement',
    example: `#include <stdio.h>\nint main(void){\n    int x = 7;\n    if (x % 2 == 0) printf("even\\n");\n    else printf("odd\\n");\n    return 0;\n}`,
  },
  switch: {
    title: 'switch',
    category: 'control flow',
    summary: 'Branch on an integer value. Remember break; — cases fall through without it.',
    syntax: 'switch (expr) { case C: ...; break; default: ...; }',
    example: `#include <stdio.h>\nint main(void){\n    int d = 3;\n    switch (d){\n        case 6: case 7: printf("weekend\\n"); break;\n        default: printf("weekday\\n");\n    }\n    return 0;\n}`,
  },
  pointers: {
    title: 'pointers',
    category: 'memory',
    summary: 'A pointer stores an address. & takes an address, * dereferences it.',
    syntax: 'int *p = &x;  *p = 5;',
    example: `#include <stdio.h>\nint main(void){\n    int x = 10;\n    int *p = &x;\n    *p = 42;         /* changes x through the pointer */\n    printf("%d\\n", x);\n    return 0;\n}`,
  },
  arrays: {
    title: 'arrays',
    category: 'memory',
    summary: 'A contiguous block of same-typed elements, indexed from 0. Arrays decay to pointers.',
    syntax: 'int a[5];  a[0] = 1;',
    example: `#include <stdio.h>\nint main(void){\n    int a[5], i, sum = 0;\n    for (i = 0; i < 5; i++) a[i] = i * i;\n    for (i = 0; i < 5; i++) sum += a[i];\n    printf("%d\\n", sum);\n    return 0;\n}`,
  },
  malloc: {
    title: 'malloc / free',
    category: 'stdlib.h',
    summary: 'Allocate memory on the heap at runtime, and release it with free(). Every malloc needs a free.',
    syntax: 'void *malloc(size_t n);  void free(void *p);',
    example: `#include <stdio.h>\n#include <stdlib.h>\nint main(void){\n    int *a = malloc(4 * sizeof(int));\n    int i;\n    for (i = 0; i < 4; i++) a[i] = i;\n    free(a);\n    return 0;\n}`,
  },
  struct: {
    title: 'struct',
    category: 'types',
    summary: 'A record grouping named fields. Access with . (value) or -> (through a pointer).',
    syntax: 'struct Name { type field; ... };',
    example: `#include <stdio.h>\nstruct Point { int x, y; };\nint main(void){\n    struct Point p;\n    p.x = 3; p.y = 4;\n    printf("%d\\n", p.x * p.x + p.y * p.y);\n    return 0;\n}`,
  },
  function: {
    title: 'functions',
    category: 'basics',
    summary: 'A named, reusable block. Declare a prototype, then define the body.',
    syntax: 'ret name(params) { ... return value; }',
    example: `#include <stdio.h>\nint square(int n){ return n * n; }\nint main(void){\n    printf("%d\\n", square(9));\n    return 0;\n}`,
  },
  string: {
    title: 'strings',
    category: 'string.h',
    summary: 'C strings are char arrays ending in a \\0. Use strlen, strcpy, strcmp, strcat.',
    syntax: 'char s[] = "hi";  strlen(s);',
    example: `#include <stdio.h>\n#include <string.h>\nint main(void){\n    char s[16] = "foo";\n    strcat(s, "bar");\n    printf("%s (%d)\\n", s, (int)strlen(s));\n    return 0;\n}`,
  },
  recursion: {
    title: 'recursion',
    category: 'basics',
    summary: 'A function that calls itself, with a base case that stops it. Watch the call stack grow.',
    syntax: 'int f(int n){ if (base) return v; return f(n-1); }',
    example: `#include <stdio.h>\nint fact(int n){ return n <= 1 ? 1 : n * fact(n - 1); }\nint main(void){ printf("%d\\n", fact(5)); return 0; }`,
  },
  fileio: {
    title: 'file I/O',
    category: 'stdio.h',
    summary: 'Open a file with fopen, read/write with fprintf/fgets/fread, then fclose.',
    syntax: 'FILE *f = fopen("name", "w"); ... fclose(f);',
    example: `#include <stdio.h>\nint main(void){\n    FILE *f = fopen("out.txt", "w");\n    fprintf(f, "hello\\n");\n    fclose(f);\n    return 0;\n}`,
  },
  preprocessor: {
    title: 'preprocessor',
    category: 'basics',
    summary: '#include pulls in headers; #define makes macros; #if/#ifdef compile conditionally.',
    syntax: '#define NAME value   #define F(x) ((x)*(x))',
    example: `#include <stdio.h>\n#define SQUARE(x) ((x) * (x))\nint main(void){ printf("%d\\n", SQUARE(6)); return 0; }`,
  },
};

export const DOC_LIST = Object.values(DOCS);
