import { Grammar, Production, isTerminal, fmtRhs, END } from '../grammar';
import { LabToken } from '../lexer';
import { ParseResult, TraceBuilder, Conflict } from '../trace';

/**
 * Earley's algorithm: a chart with one column per input position holding
 * items `A -> α • β, origin`. Three operations fill it — predict, scan,
 * complete — and the result accepts every context-free grammar, left
 * recursion and ambiguity included. Back-pointers on completed items let
 * us count parses and extract a tree (the leftmost derivation). It is the
 * lab's reference parser.
 */

export interface EarleyItem {
  id: number;
  prod: Production;
  dot: number;
  origin: number;
  column: number;
  /** How this item was created, for the chart display. */
  via: 'predict' | 'scan' | 'complete' | 'init';
  /** Derivations: each is (the item before this advance, the completed child or null for a scan). */
  derivs: { prev: EarleyItem; child: EarleyItem | null }[];
}

export interface EarleyChart {
  columns: EarleyItem[][];
}

export function fmtItem(g: Grammar, it: EarleyItem): string {
  const rhs = it.prod.rhs.map((s, k) => (k === it.dot ? '• ' : '') + s);
  const body = rhs.length ? rhs.join(' ') : '';
  return `${it.prod.lhs} -> ${it.dot >= it.prod.rhs.length ? (body ? body + ' •' : '•') : body}, ${it.origin}`;
}

export function earleyParse(g: Grammar, tokens: LabToken[], opts: { maxParses?: number } = {}): ParseResult {
  const tb = new TraceBuilder();
  const n = tokens.length;
  const columns: EarleyItem[][] = Array.from({ length: n + 1 }, () => []);
  const keys: Map<string, EarleyItem>[] = Array.from({ length: n + 1 }, () => new Map());
  let nextId = 0;
  const conflicts: Conflict[] = [];
  const add = (col: number, prod: Production, dot: number, origin: number, via: EarleyItem['via'], deriv?: { prev: EarleyItem; child: EarleyItem | null }): EarleyItem => {
    const k = `${prod.id}.${dot}.${origin}`;
    let it = keys[col]!.get(k);
    if (!it) {
      it = { id: nextId++, prod, dot, origin, column: col, via, derivs: [] };
      keys[col]!.set(k, it);
      columns[col]!.push(it);
      tb.step({ action: via, detail: `${viaText(via)}: ${fmtItem(g, it)}`, pos: col, focus: { column: col, production: prod.id } });
    }
    if (deriv) it.derivs.push(deriv);
    return it;
  };
  // Augmented start so acceptance is a single item.
  const startProd: Production = { id: -1, lhs: g.start + "'", rhs: [g.start], line: 0 };
  add(0, startProd, 0, 0, 'init');
  let errorPos: number | null = null;
  for (let col = 0; col <= n; col++) {
    const column = columns[col]!;
    if (column.length === 0) {
      errorPos = col - 1; // the token that could not be scanned
      break;
    }
    for (let idx = 0; idx < column.length; idx++) {
      const it = column[idx]!;
      const next = it.prod.rhs[it.dot];
      if (next === undefined) {
        // Complete: advance every item in the origin column waiting on it.lhs.
        const origin = columns[it.origin]!;
        for (let j = 0; j < origin.length; j++) {
          const w = origin[j]!;
          if (w.prod.rhs[w.dot] === it.prod.lhs) add(col, w.prod, w.dot + 1, w.origin, 'complete', { prev: w, child: it });
        }
      } else if (isTerminal(g, next)) {
        if (col < n && tokens[col]!.name === next) add(col + 1, it.prod, it.dot + 1, it.origin, 'scan', { prev: it, child: null });
      } else {
        for (const p of g.productions) if (p.lhs === next) add(col, p, 0, col, 'predict');
        // Nullable completion already present in this column (Aycock–Horspool).
        for (const done of column) if (done.prod.lhs === next && done.dot >= done.prod.rhs.length && done.origin === col) add(col, it.prod, it.dot + 1, it.origin, 'complete', { prev: it, child: done });
      }
    }
  }
  const finals = columns[n]!.filter((it) => it.prod === startProd && it.dot === 1 && it.origin === 0);
  const accepted = errorPos === null && finals.length > 0;
  let parses = 0;
  const roots: number[] = [];
  if (accepted) {
    const cap = opts.maxParses ?? 1000;
    // The start item may have one derivation per top-level production: sum them all.
    parses = countParses(finals[0]!, cap, new Map());
    const root = buildTree(tb, finals[0]!.derivs[0]!.child!, tokens);
    roots.push(root);
    tb.step({ action: 'accept', detail: parses > 1 ? `accepted — ambiguous: ${parses >= cap ? cap + '+' : parses} distinct parse trees` : 'accepted', pos: n, focus: { column: n } });
    if (parses > 1) conflicts.push({ kind: 'choice', where: 'input', message: `the input has ${parses >= cap ? 'at least ' + cap : parses} parse trees: the grammar is ambiguous` });
  } else {
    const at = errorPos ?? n;
    const expected = expectedAt(g, columns[at]!);
    const tok = tokens[at];
    const message = tok ? `unexpected ${tok.name} "${tok.text}" at token ${at + 1}` : `unexpected end of input`;
    tb.step({ action: 'error', detail: `${message}; expected ${expected.join(', ') || 'nothing'}`, pos: at, error: { pos: at, message, expected } });
    return { parser: 'earley', steps: tb.steps, accepted: false, treeOps: tb.treeOps, roots, conflicts, error: { pos: at, message, expected }, extra: { columns } satisfies EarleyChart };
  }
  return { parser: 'earley', steps: tb.steps, accepted, treeOps: tb.treeOps, roots, conflicts, parses, extra: { columns } satisfies EarleyChart };
}

function viaText(v: EarleyItem['via']): string {
  return v === 'predict' ? 'predict' : v === 'scan' ? 'scan' : v === 'complete' ? 'complete' : 'start';
}

function expectedAt(g: Grammar, column: EarleyItem[]): string[] {
  const out = new Set<string>();
  for (const it of column) {
    const s = it.prod.rhs[it.dot];
    if (s !== undefined && isTerminal(g, s)) out.add(s);
    if (s === undefined && it.prod.id === -1) out.add(END);
  }
  return [...out];
}

/** Number of distinct derivations of a completed item (capped). */
function countParses(it: EarleyItem, cap: number, memo: Map<EarleyItem, number>): number {
  const m = memo.get(it);
  if (m !== undefined) return m;
  memo.set(it, 1); // guard against cycles (ε-loops)
  let total = 0;
  if (it.dot === 0) total = 1;
  else {
    for (const d of it.derivs) {
      const prev = countParses(d.prev, cap, memo);
      const child = d.child ? countParses(d.child, cap, memo) : 1;
      total += prev * child;
      if (total >= cap) {
        total = cap;
        break;
      }
    }
  }
  memo.set(it, total);
  return total;
}

/** Build the first derivation's tree for a completed item; returns the node id. */
function buildTree(tb: TraceBuilder, it: EarleyItem, tokens: LabToken[]): number {
  // Walk back along derivs[0] collecting children right-to-left.
  const children: number[] = [];
  let cur = it;
  const guard = new Set<EarleyItem>();
  while (cur.dot > 0 && cur.derivs.length) {
    if (guard.has(cur)) break;
    guard.add(cur);
    const d = cur.derivs[0]!;
    if (d.child) children.push(buildTree(tb, d.child, tokens));
    else {
      const pos = cur.column - 1;
      const tok = tokens[pos]!;
      children.push(tb.node(tok.name, true, tok));
    }
    cur = d.prev;
  }
  const node = tb.node(it.prod.lhs, false);
  for (const c of children.reverse()) tb.attach(node, c);
  return node;
}

export { fmtRhs };
