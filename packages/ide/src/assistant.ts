import { FAULT_HELP, FaultKind } from '@cide/runtime';
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
