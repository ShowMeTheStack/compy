import { FAULT_HELP, FaultKind } from '@compy/runtime';
import { EXAMPLES } from './examples';
import { DOCS, DOC_LIST } from './docs';

/**
 * The offline, deterministic C assistant — always available, and the fallback
 * when no neural model is loaded. It answers concept questions from the docs,
 * retrieves the best-matching example for "write a program that…" requests, and
 * explains memory faults in plain English. Replies are markdown with ```c
 * fences the chat renders with copy buttons.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

const STOP = new Set(
  `a an the to of in on for with how do i can you please write make create program code that
   show me some example using use help what is are and or my me it c does work explain`.split(/\s+/),
);

function words(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9_ ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function code(c: string): string {
  return `\n\n\`\`\`c\n${c.trim()}\n\`\`\``;
}
function docSnippet(key: string): string {
  const d = DOCS[key];
  return d?.example ? code(d.example) : '';
}

interface Intent {
  test: RegExp;
  reply: () => string;
}

const INTENTS: Intent[] = [
  {
    test: /\b(hello|hi|hey|start|begin|help me|what can you)\b/,
    reply: () =>
      `Hi! I'm your C helper. Ask me things like *"how do pointers work?"*, *"how do I use malloc?"*, *"write a program to sort numbers"*, or paste an error and I'll explain it. I give code you can drop straight into a file and Run.`,
  },
  // ───────────── compiler-course questions (checked before the C-language ones) ─────────────
  {
    test: /\b(ssa|phi|phi[- ]node)s?\b/,
    reply: () =>
      `**SSA** (static single assignment) means every value is defined exactly once; a reassignment becomes a new version. Where two paths merge, a **phi node** picks the version that arrived from whichever predecessor ran. In this tool SSA is built by the \`mem2reg\` pass — open the Optimize panel, enable it, and look for \`phi\` at the top of merge blocks and loop headers.${docSnippet('phi')}`,
  },
  {
    test: /\bmem2reg\b/,
    reply: () =>
      `**mem2reg** promotes local variables from stack slots to SSA values: for every \`alloca\` whose address is never taken, its \`load\`s and \`store\`s are replaced by values and phi nodes and the slot is deleted. A variable whose address escapes (\`&x\`) stays in memory. Enable only mem2reg in the Optimize panel and compare the IR before and after.${docSnippet('ssa')}`,
  },
  {
    test: /\b(register allocat(ion|or)|linear[- ]scan|spill(s|ed|ing)?|regalloc)\b/,
    reply: () =>
      `**Register allocation** maps the unlimited virtual registers of the selected code onto the real RISC-V registers. **Linear scan** sorts live intervals by start and hands out registers in order, **spilling** to the stack when none is free; the naive "spill everything" allocator keeps every value in memory. Open the Assembly panel and switch allocators to compare the \`lw\`/\`sw\` traffic.${docSnippet('register allocation')}`,
  },
  {
    test: /\b(calling convention|abi|stack frame|prologue|epilogue|frame pointer|a0|a7)\b/,
    reply: () =>
      `The **calling convention** is the ABI contract between caller and callee. On RISC-V the first eight integer arguments go in \`a0\`–\`a7\`, the rest on the stack; the result returns in \`a0\`; \`ra\` holds the return address; \`s0\`–\`s11\` are callee-saved. Each function's **prologue** reserves its **stack frame** and saves \`ra\`, and its **epilogue** undoes that before \`ret\`. See it in the Assembly panel.${docSnippet('calling convention')}`,
  },
  {
    test: /\b(constant[- ](fold|propagat)\w*|fold(s|ed|ing)?)\b/,
    reply: () =>
      `**Constant folding** evaluates instructions whose operands are all constants at compile time (\`80 * 25\` becomes \`2000\`); **constant propagation** substitutes known constants into their uses so more folding becomes possible. Open the Optimize panel and watch the arithmetic in \`main\` disappear.${docSnippet('constant folding')}`,
  },
  {
    test: /\b(dead[- ]code|dce|unreachable|common subexpression|cse)\b/,
    reply: () =>
      `**Dead code elimination** removes instructions whose results are never used and blocks that can never be reached (like \`if (0)\`). **CSE** (common subexpression elimination) computes an expression such as \`w * h\` once and reuses the result. Both are visible pass-by-pass in the Optimize panel.${docSnippet('dead code')}`,
  },
  {
    test: /\b(licm|loop[- ]invariant|hoist(s|ed|ing)?)\b/,
    reply: () =>
      `**Loop-invariant code motion** (LICM) finds computations inside a loop whose operands never change in the loop, such as \`k * 7\`, and hoists them to a preheader block that runs once. Enable LICM in the Optimize panel and watch the \`mul\` move out of the loop body.`,
  },
  {
    test: /\b(strength reduc\w*|shift instead|multiply by (two|2|eight|8))\b/,
    reply: () =>
      `**Strength reduction** swaps an expensive operation for a cheaper one with the same result: \`i * 8\` becomes \`i << 3\`, \`x * 2\` becomes \`x + x\`, and for **unsigned** values \`u / 4\` becomes \`u >> 2\` and \`u % 4\` becomes \`u & 3\` (signed division cannot be shifted because of negative values). Look for \`shl\`/\`shr\` replacing \`mul\`/\`div\` in the Optimize panel.`,
  },
  {
    test: /\binlin(e|ed|er|ing)\b/,
    reply: () =>
      `**Inlining** replaces a call to a small function with a copy of its body, removing the call overhead and letting the other passes (folding, CSE, LICM) see through the former call. Enable the inliner in the Optimize panel and search the Assembly panel for \`call\`.${docSnippet('inlining')}`,
  },
  {
    test: /\b(basic[- ]blocks?|cfg|control[- ]flow graph)\b/,
    reply: () =>
      `A **basic block** is a straight-line run of IR instructions with one entry and one exit (a branch, jump or return). Blocks plus their branch edges form the **control-flow graph** (CFG): loops are cycles, if/else is a diamond, \`break\` and \`continue\` add extra edges. The IR panel lists blocks with labels; read the successors off each block's final branch.${docSnippet('cfg')}`,
  },
  {
    test: /\b(tokens?|lexer|lexing|lexical|tokeni[sz]\w*|scanner|maximal munch)\b/,
    reply: () =>
      `A **token** is the smallest meaningful unit of source — keyword, identifier, constant, string literal or punctuator. The **lexer** scans characters into tokens using **maximal munch** (always the longest match, so \`a+++b\` is \`a++ + b\`), dropping whitespace and comments. Open the Tokens panel and hover any token to see its kind, spelling and position.${docSnippet('lexer')}`,
  },
  {
    test: /\b(ast|parse tree|syntax tree|parser|parsing|grammar|recursive descent|precedence|dangling else)\b/,
    reply: () =>
      `The **parser** consumes tokens and builds an **AST** (abstract syntax tree) according to the C **grammar**, one recursive-descent function per rule, with precedence climbing for expressions. Open the AST panel to see the tree: the root operator of an expression is the one that binds loosest, and an \`else\` is a child of the nearest \`if\`.${docSnippet('ast')}`,
  },
  {
    test: /\b(symbol table|scope|scoping|shadow(s|ed|ing)?|semantic analysis|type check\w*)\b/,
    reply: () =>
      `**Semantic analysis** resolves every name through a stack of **symbol tables** (one per scope — inner declarations shadow outer ones) and computes a type for every expression, inserting the integer promotions and usual arithmetic conversions. The Types panel shows which declaration each name resolved to and where conversions were inserted.${docSnippet('symbol table')}`,
  },
  {
    test: /\b(ir|intermediate representation|three[- ]address|lowering|lower(s|ed)? to ir)\b/,
    reply: () =>
      `The **IR** (intermediate representation) is what the AST is lowered into: **three-address code**, where each instruction has one operator, a destination and at most two sources, grouped into basic blocks. Before optimisation every local lives in a stack slot with explicit loads and stores. Open the IR panel and match each C line to its instructions.${docSnippet('basic block')}`,
  },
  {
    test: /\b(optimi[sz]e[rd]?|optimi[sz]ations?|optimi[sz]ing|-?o2)\b/,
    reply: () =>
      `The **optimizer** runs a pipeline of passes over the IR: \`mem2reg\` (locals to SSA), constant folding and propagation, strength reduction, CSE, dead code elimination, LICM, inlining and CFG simplification, repeated until nothing changes. The Optimize panel lets you enable passes one at a time and diff the IR after each — ask me about any pass by name.`,
  },
  {
    test: /\b(codegen|code generation|assembly|asm|risc[- ]?v|rv32|instruction selection|machine code)\b/,
    reply: () =>
      `**Code generation** turns IR into RISC-V (RV32) machine code in three steps: **instruction selection** maps each IR instruction to real instructions (watching 12-bit immediates: \`addi\` for small constants, \`lui\`+\`addi\` for large), **register allocation** maps virtual registers to real ones, and frame layout adds the prologue and epilogue. Open the Assembly panel to read the listing, annotated with source lines.${docSnippet('stack frame')}`,
  },
  {
    test: /\b(loop|repeat|iterate|for each|counting)\b/,
    reply: () => `Use a **for** loop when you know the count:${docSnippet('for')}\nUse **while** when you don't.`,
  },
  { test: /\bwhile\b/, reply: () => `A **while** loop repeats while its condition is true:${docSnippet('while')}` },
  {
    test: /\b(print|output|printf|display|format)\b/,
    reply: () => `**printf** writes formatted text: \`%d\` int, \`%f\` double, \`%s\` string, \`%c\` char.${docSnippet('printf')}`,
  },
  { test: /\b(scanf|input|read.*(user|keyboard)|ask)\b/, reply: () => `Read input with **scanf** — pass the ADDRESS with \`&\`:${docSnippet('scanf')}` },
  { test: /\b(if|else|condition|branch|compare)\b/, reply: () => `Branch with **if / else**:${docSnippet('if')}` },
  { test: /\b(switch|case)\b/, reply: () => `**switch** branches on an integer — don't forget \`break;\`:${docSnippet('switch')}` },
  {
    test: /\b(pointer|address|deref|dereference|\*p|&)\b/,
    reply: () => `A **pointer** holds an address. \`&x\` takes the address of \`x\`; \`*p\` reads/writes through it:${docSnippet('pointers')}\nOpen the Memory panel while it runs to see the pointer point at its target.`,
  },
  { test: /\b(array|list|table|index)\b/, reply: () => `An **array** is a contiguous block indexed from 0:${docSnippet('arrays')}` },
  {
    test: /\b(malloc|heap|allocate|free|calloc|realloc|dynamic memory)\b/,
    reply: () => `Allocate on the **heap** with malloc and release with free — every malloc needs a free:${docSnippet('malloc')}\nThe Memory panel shows each heap block; forget the free() and the sandbox reports a leak.`,
  },
  { test: /\b(struct|record|field)\b/, reply: () => `A **struct** groups named fields; use \`.\` or \`->\`:${docSnippet('struct')}` },
  { test: /\b(function|procedure|prototype|return)\b/, reply: () => `A **function** is a reusable block:${docSnippet('function')}` },
  { test: /\b(string|char array|strlen|strcpy|strcmp)\b/, reply: () => `C **strings** are char arrays ending in \`\\0\`:${docSnippet('string')}` },
  { test: /\b(recursion|recursive)\b/, reply: () => `**Recursion** is a function calling itself with a base case:${docSnippet('recursion')}\nWatch the call stack grow in the debugger.` },
  { test: /\b(file|fopen|fread|fwrite|fgets|save|load)\b/, reply: () => `Read and write files with **fopen / fprintf / fgets / fclose**:${docSnippet('fileio')}` },
  { test: /\b(macro|#define|#include|preprocessor)\b/, reply: () => `The **preprocessor** runs first — \`#include\`, \`#define\`, \`#if\`:${docSnippet('preprocessor')}\nUse the Preprocessor lens to see macros expand.` },
];

/** If the message looks like a memory fault, explain that fault. */
function faultReply(low: string): string | null {
  const map: [RegExp, FaultKind][] = [
    [/use[- ]after[- ]free|dangling/, 'use-after-free'],
    [/double[- ]free/, 'double-free'],
    [/invalid[- ]free/, 'invalid-free'],
    [/null|segfault|segmentation/, 'null-deref'],
    [/out[- ]of[- ]bounds|overflow.*array|index/, 'out-of-bounds'],
    [/uninitial/, 'uninitialized-read'],
    [/leak/, 'leak'],
    [/read[- ]only|const.*write/, 'write-to-readonly'],
    [/stack[- ]overflow|too much recursion/, 'stack-overflow'],
  ];
  for (const [re, kind] of map) {
    if (re.test(low)) {
      return `**${kind}** — ${FAULT_HELP[kind]}\n\nRun your program and the sandbox will point at the exact line. Open the Memory panel to see what the pointer refers to.`;
    }
  }
  return null;
}

interface Scored {
  score: number;
}
function bestExample(qWords: string[], exclude: Set<string>): Example & Scored {
  let best: Example & Scored = { ...EXAMPLES[0]!, score: -1 };
  for (const ex of EXAMPLES) {
    if (exclude.has(ex.name)) continue;
    const hay = `${ex.name} ${ex.description} ${ex.category}`.toLowerCase();
    let score = 0;
    for (const w of qWords) if (hay.includes(w)) score += hay.includes(` ${w}`) ? 2 : 1;
    if (score > best.score) best = { ...ex, score };
  }
  return best;
}
function bestDoc(qWords: string[]): { score: number; key: string } {
  let best = { score: -1, key: '' };
  for (const d of DOC_LIST) {
    const hay = `${d.title} ${d.summary} ${d.category}`.toLowerCase();
    let score = 0;
    for (const w of qWords) if (hay.includes(w)) score += 1;
    if (score > best.score) best = { score, key: d.title };
  }
  return best;
}

type Example = (typeof EXAMPLES)[number];

const FALLBACK = `I'm not sure I follow — try rephrasing, or ask about a concept like *pointers*, *malloc*, *arrays*, *structs* or *files*. Paste a compiler error or a memory fault and I'll explain it, or say *"write a program that …"* and I'll give you one.`;

export function respond(query: string, history: ChatMessage[] = []): string {
  const q = query.trim();
  if (!q) return INTENTS[0]!.reply();
  let low = q.toLowerCase();

  const fault = faultReply(low);
  if (fault) return fault;

  const followUp = /^(another|more|again|different|next|one more|show (me )?another|something else)\b/.test(low);
  const shown = new Set(
    history.filter((m) => m.role === 'assistant').flatMap((m) => [...m.text.matchAll(/\*\*(.+?)\*\*/g)].map((x) => x[1]!)),
  );
  let effective = q;
  if (followUp) {
    const prevUser = [...history].reverse().find((m) => m.role === 'user');
    if (prevUser) {
      effective = prevUser.text;
      low = effective.toLowerCase();
    }
  } else {
    for (const intent of INTENTS) if (intent.test.test(low)) return intent.reply();
  }

  const qWords = words(effective);
  const wantsProgram = followUp || /\b(program|game|write|make|build|create|generate|solution|implement)\b/.test(low);
  const ex = bestExample(qWords, shown);
  const doc = bestDoc(qWords);

  if (wantsProgram && ex.score > 0) {
    return `Here's a program that should help — **${ex.name}** (${ex.category}):${code(ex.files['main.c'] ?? '')}\n\n${ex.description} Copy it into a file and press ▶ Run.`;
  }
  if (doc.score >= ex.score && doc.score > 0) {
    const d = DOCS[doc.key]!;
    return `**${d.title}** — ${d.summary}\n\nSyntax: \`${d.syntax}\`${d.example ? code(d.example) : ''}`;
  }
  if (ex.score > 0) {
    return `You might like **${ex.name}** (${ex.category}):${code(ex.files['main.c'] ?? '')}\n\n${ex.description}`;
  }
  return FALLBACK;
}
