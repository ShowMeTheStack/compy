# CIDE — a C89 teaching IDE that runs entirely in the browser

CIDE compiles and runs C (the complete C89 standard, plus friendly extras and
VLAs) with **no server and no WebAssembly compiler** — a from-scratch C
front-end and interpreter execute your program over a **real, inspectable
process-memory model**. It is built for beginning students: every pointer,
every `malloc`, every stack frame is visible and editable, and the classic C
bugs are caught and explained instead of silently corrupting memory.

## What makes it different

- **A real process memory model.** One little-endian ILP32 address space laid
  out like a real program: a NULL guard page, `text`, `rodata` (string literals
  and `const`), `data` (initialized globals), `bss` (zero-init globals), the
  **heap** (grows up), and the **stack** (grows down). The visualizer keeps the
  stack and heap — the two students always confuse — visually separate, and you
  can click any byte to edit it.
- **Valgrind-for-beginners.** Every memory access is checked, so the sandbox
  reports null-dereference, out-of-bounds, uninitialized reads, use-after-free,
  double-free, invalid-free, writes to read-only memory, stack overflow, and
  leaks — each with the exact address, the line, and a plain-English
  explanation.
- **A complete preprocessor** with a "preprocessor lens": `#include` over a
  virtual filesystem, object- and function-like macros with `#`/`##`, the full
  `#if` family with a constant-expression evaluator, and predefined macros.
- **A full front-end:** lexer, parser, and semantic analysis with types, scopes,
  ILP32 layout, `Ctrl`+click go-to-definition, and error underlines.
- **A from-scratch libc** over an emulated syscall layer + virtual filesystem:
  `printf`/`scanf` families, `malloc`/`free`, `string.h`, `math.h`, `ctype.h`,
  FILE streams, and more — 13 standard headers you can `#include`.
- **A time-travel debugger:** breakpoints, step in/over/out, continue, a live
  call stack and locals — navigate forwards *and backwards* through execution.
- **Multi-file projects** with linking, persisted in your browser.

## Correctness

The interpreter is differentially tested against **real Apple clang**
(`-std=c89`): a corpus of programs is run on both engines and their stdout and
exit codes are compared byte-for-byte. This has already caught and fixed real
bugs. Run it with `npm test` (the oracle suite is skipped automatically where
`clang` isn't installed).

## Architecture

A TypeScript monorepo (npm workspaces):

| Package         | Responsibility                                                        |
| --------------- | -------------------------------------------------------------------- |
| `@cide/runtime` | segmented memory model, fault vocabulary, VFS, console, syscalls      |
| `@cide/cc`      | lexer, preprocessor, parser + AST, types, semantic analysis          |
| `@cide/vm`      | the tree-walking interpreter and the debugger engine                 |
| `@cide/libc`    | the C89 standard library + standard headers + the compile/run driver |
| `@cide/ide`     | the React app: editor, memory visualizer, debugger, panels           |
| `@cide/testgen` | the clang differential oracle and program corpus                     |

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
