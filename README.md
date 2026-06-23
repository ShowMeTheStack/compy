# Compy — see how a compiler works, in the browser

**compy.jyotiprakash.org**

Compy is a teaching tool for *how compilers work*. It uses C89 as the substrate
and lets students watch every phase of compilation happen to their own program:
source text becoming **tokens**, tokens becoming a **parse tree**, the tree
acquiring **types and scopes**, and the program then executing over a **real,
inspectable process-memory model**. Everything runs client-side: a from-scratch
C front-end and runtime with **no server and no WebAssembly compiler**.

The roadmap takes the same program through the back half of a compiler too:
lowering to an **intermediate representation**, **optimization** passes you can
toggle and diff, and **code generation** to a small target ISA you can step
through. See [STATUS.md](STATUS.md) for what is built and what remains.

## What a student sees

- **Lexing.** Translation phases 1–3 (trigraphs, line splicing, comments) and
  maximal-munch tokenization of the full C89 token set.
- **Preprocessing** with a "preprocessor lens": `#include` over a virtual
  filesystem, object- and function-like macros with `#`/`##`, the full `#if`
  family with a constant-expression evaluator, and predefined macros.
- **Parsing.** A recursive-descent parser for all of C89 (plus friendly extras
  and VLAs) that produces an AST with source spans on every node.
- **Semantic analysis.** Types, scopes, ILP32 layout, usual arithmetic
  conversions, `Ctrl`+click go-to-definition, and error underlines.
- **Execution over a real process memory model.** One little-endian ILP32
  address space laid out like a real program: a NULL guard page, `text`,
  `rodata`, `data`, `bss`, the **heap** (grows up), and the **stack** (grows
  down). Stack and heap are kept visually separate, and any byte is editable.
- **Valgrind-for-beginners.** Every memory access is checked: null-dereference,
  out-of-bounds, uninitialized reads, use-after-free, double-free, invalid-free,
  writes to read-only memory, stack overflow, and leaks — each with the exact
  address, the line, and a plain-English explanation.
- **A from-scratch libc** over an emulated syscall layer + virtual filesystem:
  `printf`/`scanf` families, `malloc`/`free`, `string.h`, `math.h`, `ctype.h`,
  FILE streams, and more — 13 standard headers you can `#include`.
- **A time-travel debugger:** breakpoints, step in/over/out, continue, a live
  call stack and locals — navigate forwards *and backwards* through execution.
- **Multi-file projects** with linking, persisted in your browser, and an
  in-browser AI assistant (offline C brain + optional local small model).

## Correctness

The interpreter is differentially tested against **real Apple clang**
(`-std=c89`): a corpus of programs is run on both engines and their stdout and
exit codes are compared byte-for-byte. This has already caught and fixed real
bugs. Run it with `npm test` (the oracle suite is skipped automatically where
`clang` isn't installed).

## Architecture

A TypeScript monorepo (npm workspaces):

| Package          | Responsibility                                                        |
| ---------------- | --------------------------------------------------------------------- |
| `@compy/runtime` | segmented memory model, fault vocabulary, VFS, console, syscalls      |
| `@compy/cc`      | lexer, preprocessor, parser + AST, types, semantic analysis           |
| `@compy/vm`      | the tree-walking interpreter and the debugger engine                  |
| `@compy/libc`    | the C89 standard library + standard headers + the compile/run driver  |
| `@compy/ide`     | the React app: editor, memory visualizer, debugger, panels            |
| `@compy/testgen` | the clang differential oracle and program corpus                      |

Planned: `@compy/ir` (lowering, SSA/CFG, optimization passes) and
`@compy/codegen` (target ISA, instruction selection, register allocation).

## Develop

```sh
npm install
npm run dev        # start the IDE (Vite dev server)
npm test           # unit tests (vitest), incl. the clang oracle
npm run build      # production build
npm run test:e2e   # Playwright end-to-end tests (after a build)
npm run test:all   # unit + build + e2e
```

## Dialect

C89 by default, with friendly extras accepted (with a warning, toggleable to
strict): `//` comments, mixed and mid-block declarations, `for`-loop init
declarations, `long long`, `_Bool`/`<stdbool.h>`, and variable-length arrays.
The model is ILP32, little-endian: `int`/`long`/pointer = 4 bytes, `char` = 1,
`short` = 2, `long long` = 8, `float` = 4, `double` = 8.
