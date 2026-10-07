# Compy — see how a compiler works, in the browser

**[compy.jyotiprakash.org](https://compy.jyotiprakash.org)**

Compy is a teaching tool for *how compilers work*. It uses C89 as the substrate
and lets students watch every phase of compilation happen to their own program,
live, as they type:

```
Source → Tokens → Preprocess → Parse → Types → IR → Optimize → Codegen → Run
```

Everything runs client-side: a from-scratch C front-end, an LLVM-style IR with
an optimizer, a RISC-V back-end with two register allocators, and three
execution engines — all over one real, inspectable process-memory model. There
is **no server and no WebAssembly compiler**; the entire toolchain is
TypeScript you can read.

## What a student sees

| Phase | Panel |
| --- | --- |
| **Lexing** | the token stream, raw (translation phases 1–3) or after preprocessing, colour-coded by kind; hover a token to light up its source |
| **Preprocessing** | a lens over every `#define`, expansion, `#include` and `#if`, plus the output stream with macro-produced tokens marked |
| **Parsing** | a collapsible AST; every node links to its span; declarators nest from the identifier outward (the "spiral rule" made visible) |
| **Semantic analysis** | the symbol table with resolved types, sizes, alignment and linkage; struct layouts with padding drawn in; expression types annotated on the AST |
| **IR** | a typed three-address CFG IR (allocas → mem2reg → SSA with phis) as text or as a drawn control-flow graph; an instruction stepper with register values |
| **Optimization** | eight toggleable passes — simplifycfg, mem2reg, inlining, constant folding, algebraic simplification / strength reduction, CSE, DCE, LICM — each with an explanation and a before/after diff of every function it changed |
| **Code generation** | RV32IMFD assembly with source-line comments; the pre-regalloc listing with virtual registers; the allocator's live-interval chart (linear scan vs. spill-everything); a machine stepper showing the register file change instruction by instruction |
| **Run** | three engines (AST interpreter, IR interpreter, RISC-V simulator) that must agree; the memory visualizer (stack/heap/data/bss/rodata kept separate, every byte editable); valgrind-for-beginners fault reports; a time-travel debugger that steps forwards *and backwards* |
| **Learn** | a 32-lesson compilers course; each lesson loads a program and tells the student what to look for |

## The Language lab

A second mode for automata-theory and parsing courses: define your own tokens and grammar and
watch the machinery work.

- **Lexing**: a flex-like rule file (priorities, `skip:` rules, start conditions) compiled through
  Thompson's construction, subset construction and Hopcroft minimization, each drawn; a scanner
  stepper that animates maximal munch on the input tape; a regex membership tester; a character
  lexer for `aⁿbⁿ`-style grammars; or paste the tokens directly.
- **Grammars**: BNF with literals, ε and precedence declarations; nullable/FIRST/FOLLOW replayed
  iteration by iteration; checks (left recursion, common prefixes, useless symbols) with one-click
  fixes; ε/unit/useless removal, left-recursion elimination, left factoring and CNF conversion,
  each shown as a diff.
- **Parsers**, all on one stepper with the tree growing alongside: recursive descent (generated
  pseudocode and call stack), LL(1) (predict table), LR(0), SLR(1), canonical LR(1) and LALR(1)
  (item sets, goto-graph automaton, ACTION/GOTO tables with conflicts), Earley (chart, parse
  counting for ambiguity), CYK (the triangle), and operator precedence (precedence climbing).
- **CFG → PDA**: the textbook construction, drawn, with a nondeterministic configuration stepper.
- 13 presets (dangling else, LALR-but-not-LR(1), palindromes, JSON…) and 19 lessons.

Every parser is cross-checked against Earley on random sentences; transformations are checked to
preserve the language; the PDA is checked against Earley.

All graphs (automata, goto graphs, control-flow graphs) share one layered layout engine that
guarantees edges never pass through nodes and labels never overlap anything; every diagram opens
as a central panel with zoom and pan.

## Correctness

Every layer is checked against the one below it, and the bottom is checked
against real **Apple clang** (`-std=c89`):

- the AST interpreter is differentially tested against clang on a program corpus (stdout and exit code byte-for-byte);
- the IR lowering and every optimizer pass (alone and in the full pipeline) are differentially tested against the AST interpreter on 36 programs;
- the generated RISC-V code is differentially tested on the same programs at O0/O2 with both register allocators;
- every lesson and example program must produce identical output on all three engines.

`npm test` runs all of it (the clang suite skips itself where `clang` is absent). On top of
that, `npm run test:e2e` drives the real UI in a headless browser through 3,669 generated
cases: every program on every engine and in every panel, the debugger and steppers, the
optimizer toggles, every lab preset with every parser, the lessons, and layout invariants
(no overflow, no overlapping controls) at four viewport widths.

## Architecture

A TypeScript monorepo (npm workspaces):

| Package           | Responsibility                                                                 |
| ----------------- | ------------------------------------------------------------------------------ |
| `@compy/runtime`  | segmented ILP32 memory model, fault vocabulary, VFS, console, syscalls          |
| `@compy/cc`       | lexer, preprocessor, parser + AST, types, semantic analysis                     |
| `@compy/vm`       | the AST (tree-walking) interpreter and the debugger engine                      |
| `@compy/libc`     | the C89 standard library + headers + the compile/run driver                     |
| `@compy/ir`       | the IR, AST → IR lowering, the IR interpreter, and the optimizer passes         |
| `@compy/codegen`  | RV32IMFD instruction selection, register allocation, frame layout, simulator    |
| `@compy/lab`      | the language lab engines: regex/automata, scanner, grammar analyses, parsers    |
| `@compy/ide`      | the React app: editor, phase bar, phase panels, memory visualizer, lessons, AI  |
| `@compy/testgen`  | the clang differential oracle and the program corpus                            |

The three engines share one `NativeHost` interface, so a single libc serves the
AST interpreter, the IR interpreter and the simulator (where library functions
are linked as trampolines at real text addresses, so function pointers work
uniformly).

## Develop

```sh
npm install
npm run dev        # start the IDE (Vite dev server)
npm test           # unit + differential tests (vitest)
npm run build      # production build
npm run test:e2e   # Playwright end-to-end tests (after a build)
npm run test:all   # unit + build + e2e
```

Deployment to compy.jyotiprakash.org is described in [DEPLOY.md](DEPLOY.md).

## Dialect and target

C89 with friendly extras accepted (warned, toggleable to strict): `//` comments,
mixed declarations, `for`-loop init declarations, `long long`, `_Bool`, VLAs.
The model is ILP32, little-endian: `int`/`long`/pointer = 4 bytes, `char` = 1,
`short` = 2, `long long` = 8, `float` = 4, `double` = 8. The code generator
targets RV32IM with the F and D extensions; 64-bit integers live in register
pairs and use libgcc-style helpers, as on real rv32 toolchains.

Not supported: `setjmp`/`longjmp` and user-defined variadic functions (`va_arg`).
