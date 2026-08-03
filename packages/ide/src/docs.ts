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
  // ───────────── compiler terms ─────────────
  token: {
    title: 'token',
    category: 'compiler: lexing',
    summary: 'The smallest meaningful unit of source: a keyword, identifier, constant, string literal or punctuator. The lexer produces tokens; the parser consumes them.',
    syntax: 'int x = 0x10 + y;   →   int  x  =  0x10  +  y  ;  (7 tokens)',
    example: `#include <stdio.h>\nint main(void){\n    int x = 0x10 + 1;   /* keyword identifier = constant + constant ; */\n    printf("%d\\n", x);\n    return 0;\n}`,
  },
  lexer: {
    title: 'lexer',
    category: 'compiler: lexing',
    summary: 'The first compiler phase: scans characters into tokens using maximal munch, discarding whitespace and comments. Also called scanner or tokenizer.',
    syntax: 'characters → lexer → tokens → parser',
    example: `#include <stdio.h>\nint main(void){\n    int a = 5, b = 3;\n    int c = a+++b;      /* lexed as a++ + b */\n    printf("%d %d\\n", c, a);\n    return 0;\n}`,
  },
  parser: {
    title: 'parser',
    category: 'compiler: parsing',
    summary: 'Turns the token stream into an abstract syntax tree according to the grammar. C compilers use recursive descent with precedence climbing for expressions.',
    syntax: 'tokens → parser → AST',
    example: `#include <stdio.h>\nint main(void){\n    /* the parser groups this as 1 + (2 * 3), not (1 + 2) * 3 */\n    printf("%d\\n", 1 + 2 * 3);\n    return 0;\n}`,
  },
  ast: {
    title: 'ast',
    category: 'compiler: parsing',
    summary: 'Abstract syntax tree: the tree the parser builds, with one node per construct (declaration, statement, expression) and the nesting of the source made explicit.',
    syntax: 'a = b + c * d   →   Assign(a, Add(b, Mul(c, d)))',
    example: `#include <stdio.h>\nint main(void){\n    int a, b = 2, c = 3, d = 4;\n    a = b + c * d;     /* Assign(a, Add(b, Mul(c, d))) */\n    printf("%d\\n", a);\n    return 0;\n}`,
  },
  grammar: {
    title: 'grammar',
    category: 'compiler: parsing',
    summary: 'A set of context-free rules describing which token sequences form valid programs. Each rule becomes one function in a recursive-descent parser.',
    syntax: "expr := term ('+' term)*     term := factor ('*' factor)*",
    example: `#include <stdio.h>\nstatic const char *s = "2+3*4";\nstatic int p = 0;\nstatic int factor(void){ return s[p++] - '0'; }\nstatic int term(void){ int v = factor(); while (s[p] == '*'){ p++; v *= factor(); } return v; }\nstatic int expr(void){ int v = term(); while (s[p] == '+'){ p++; v += term(); } return v; }\nint main(void){ printf("%d\\n", expr()); return 0; }`,
  },
  'symbol table': {
    title: 'symbol table',
    category: 'compiler: semantic analysis',
    summary: 'A map from names to declarations, one per scope, stacked so that inner scopes shadow outer ones. Semantic analysis uses it to resolve every identifier.',
    syntax: 'lookup(name): search innermost scope outward, first hit wins',
    example: `#include <stdio.h>\nint x = 1;\nint main(void){\n    printf("%d ", x);          /* global x */\n    { int x = 2; printf("%d ", x); }   /* inner x shadows it */\n    printf("%d\\n", x);         /* global again */\n    return 0;\n}`,
  },
  'basic block': {
    title: 'basic block',
    category: 'compiler: IR',
    summary: 'A maximal straight-line sequence of IR instructions with one entry (the first instruction) and one exit (the final branch, jump or return).',
    syntax: 'label:  instr; instr; ...; branch/jump/return',
    example: `#include <stdio.h>\nint main(void){\n    int i, s = 0;\n    for (i = 0; i < 5; i++)   /* header block, body block, exit block */\n        s += i;\n    printf("%d\\n", s);\n    return 0;\n}`,
  },
  cfg: {
    title: 'cfg',
    category: 'compiler: IR',
    summary: 'Control-flow graph: basic blocks as nodes, branches as edges. Loops are cycles; if/else is a diamond. Every optimisation walks it.',
    syntax: 'entry → header ⇄ body → exit',
    example: `#include <stdio.h>\nint main(void){\n    int i = 0, s = 0;\n    while (i < 10){\n        i++;\n        if (i == 7) break;         /* extra edge to exit */\n        if (i % 2) continue;       /* extra back edge to header */\n        s += i;\n    }\n    printf("%d\\n", s);\n    return 0;\n}`,
  },
  ssa: {
    title: 'ssa',
    category: 'compiler: IR',
    summary: 'Static single assignment: every value is defined exactly once. Reassignments become new versions, and phi nodes merge versions where paths join.',
    syntax: 'x1 = ...; x2 = ...; x3 = phi(x1, x2)',
    example: `#include <stdio.h>\nint sign(int n){\n    int r;                 /* r1 and r2 below, r3 = phi(r1, r2) at the return */\n    if (n < 0) r = -1; else r = 1;\n    return r;\n}\nint main(void){ printf("%d %d\\n", sign(-5), sign(5)); return 0; }`,
  },
  phi: {
    title: 'phi',
    category: 'compiler: IR',
    summary: 'A phi node sits at the top of a merge block and selects the incoming value from whichever predecessor control arrived from. Created by mem2reg.',
    syntax: 'x3 = phi [x1, from_then], [x2, from_else]',
    example: `#include <stdio.h>\nint main(void){\n    int i, acc = 0;         /* acc gets a phi in the loop header */\n    for (i = 0; i < 4; i++) acc += i;\n    printf("%d\\n", acc);\n    return 0;\n}`,
  },
  'constant folding': {
    title: 'constant folding',
    category: 'compiler: optimization',
    summary: 'Evaluate instructions whose operands are all constants at compile time; constant propagation then substitutes the result into its uses.',
    syntax: 't = 80 * 25   →   t = 2000',
    example: `#include <stdio.h>\n#define W 80\n#define H 25\nint main(void){\n    int cells = W * H;          /* folded to 2000 */\n    int bytes = cells * 4;      /* propagated, then folded to 8000 */\n    printf("%d %d\\n", cells, bytes);\n    return 0;\n}`,
  },
  'dead code': {
    title: 'dead code',
    category: 'compiler: optimization',
    summary: 'Instructions whose results are never used, or blocks that can never be reached. Dead code elimination (DCE) deletes both.',
    syntax: 'unused = w * h;  if (0) {...}   →   (removed)',
    example: `#include <stdio.h>\nint f(int w, int h){\n    int unused = w * h * 2;      /* never read: removed */\n    if (0) printf("never\\n");   /* unreachable: removed */\n    return w + h;\n}\nint main(void){ printf("%d\\n", f(3, 4)); return 0; }`,
  },
  'register allocation': {
    title: 'register allocation',
    category: 'compiler: codegen',
    summary: 'Map unlimited virtual registers onto the few real ones. Linear scan walks live intervals in order; values that do not fit are spilled to the stack.',
    syntax: 'v0..vN → t0-t6, s0-s11, a0-a7 (+ stack slots for spills)',
    example: `#include <stdio.h>\nint main(void){\n    int a = 1, b = 2, c = 3, d = 4, i, r = 0;   /* six values live in the loop */\n    for (i = 0; i < 3; i++){ a += b; b += c; c += d; d += a; r += a + b + c + d; }\n    printf("%d\\n", r);\n    return 0;\n}`,
  },
  'calling convention': {
    title: 'calling convention',
    category: 'compiler: codegen',
    summary: 'The ABI rules for calls: on RISC-V the first eight integer arguments go in a0-a7, extras on the stack, the result returns in a0, and s-registers are callee-saved.',
    syntax: 'args: a0..a7 then stack;  result: a0;  ra = return address',
    example: `#include <stdio.h>\nint sum10(int a, int b, int c, int d, int e, int f, int g, int h, int i, int j){\n    return a + b + c + d + e + f + g + h + i + j;   /* i and j arrive on the stack */\n}\nint main(void){ printf("%d\\n", sum10(1,2,3,4,5,6,7,8,9,10)); return 0; }`,
  },
  'stack frame': {
    title: 'stack frame',
    category: 'compiler: codegen',
    summary: 'The region of stack a function owns during a call: saved return address, saved registers, locals and spills. Built by the prologue, torn down by the epilogue.',
    syntax: 'addi sp, sp, -N;  sw ra, ...   /* prologue */   ...   lw ra, ...;  addi sp, sp, N;  ret',
    example: `#include <stdio.h>\nint depth(int n){\n    int local[4];            /* lives in this call's frame */\n    local[0] = n;\n    return n == 0 ? 0 : local[0] + depth(n - 1);\n}\nint main(void){ printf("%d\\n", depth(4)); return 0; }`,
  },
  inlining: {
    title: 'inlining',
    category: 'compiler: optimization',
    summary: 'Replace a call to a small function with a copy of its body, removing call overhead and letting other passes optimise across the former call.',
    syntax: 's += sq(i);   →   s += i * i;',
    example: `#include <stdio.h>\nstatic int sq(int x){ return x * x; }\nint main(void){\n    int i, s = 0;\n    for (i = 1; i <= 4; i++) s += sq(i);   /* no call after inlining */\n    printf("%d\\n", s);\n    return 0;\n}`,
  },
};

export const DOC_LIST = Object.values(DOCS);
