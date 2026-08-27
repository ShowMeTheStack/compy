import { Grammar, Production, analyzeGrammar, firstOfSequence, isTerminal, fmtProduction, END } from '../grammar';
import { LabToken } from '../lexer';
import { ParseResult, TraceBuilder, Conflict } from '../trace';

/**
 * LL(1): the predict table M[A, a] built from FIRST and FOLLOW, driven by an
 * explicit stack. A cell with more than one production is a conflict; the
 * driver picks the first and says so, which is what a student needs to see.
 */
export interface Ll1Table {
  /** nonterminal → terminal → production ids. */
  cells: Map<string, Map<string, number[]>>;
  terminals: string[];
  conflicts: Conflict[];
}

export function buildLl1Table(g: Grammar): Ll1Table {
  const an = analyzeGrammar(g);
  const cells = new Map<string, Map<string, number[]>>();
  const conflicts: Conflict[] = [];
  for (const nt of g.nonterminals) cells.set(nt, new Map());
  for (const p of g.productions) {
    const f = firstOfSequence(p.rhs, an.first, an.nullable);
    const terms = new Set(f.set);
    if (f.nullable) for (const t of an.follow.get(p.lhs) ?? []) terms.add(t);
    for (const t of terms) {
      const row = cells.get(p.lhs)!;
      row.set(t, [...(row.get(t) ?? []), p.id]);
    }
  }
  for (const [nt, row] of cells) for (const [t, ids] of row) if (ids.length > 1) {
    conflicts.push({ kind: 'predict', where: `M[${nt}, ${t}]`, symbol: t, message: `M[${nt}, ${t}] holds ${ids.length} productions: ${ids.map((id) => fmtProduction(g, g.productions[id]!)).join('  /  ')}` });
  }
  return { cells, terminals: [...g.terminals, END], conflicts };
}

export function ll1Parse(g: Grammar, tokens: LabToken[]): ParseResult {
  const table = buildLl1Table(g);
  const tb = new TraceBuilder();
  const input = [...tokens.map((t) => t.name), END];
  // Stack entries: a symbol and the tree node that will hold it (or its parent for terminals).
  type Entry = { sym: string; node: number | null; parent: number | null };
  const rootId = tb.node(g.start, false);
  const stack: Entry[] = [{ sym: END, node: null, parent: null }, { sym: g.start, node: rootId, parent: null }];
  let pos = 0;
  const fmtStack = () => stack.map((e) => e.sym).reverse();
  tb.step({ action: 'init', detail: `push ${END} and the start symbol ${g.start}`, pos, stack: fmtStack() });
  for (let guard = 0; guard < 100000; guard++) {
    const top = stack[stack.length - 1]!;
    const a = input[pos]!;
    if (top.sym === END) {
      if (a === END) {
        tb.step({ action: 'accept', detail: 'stack and input both at $: accepted', pos, stack: fmtStack() });
        return { parser: 'll1', steps: tb.steps, accepted: true, treeOps: tb.treeOps, roots: [rootId], conflicts: table.conflicts, extra: table };
      }
      return fail(tb, g, table, pos, tokens, [END], rootId, fmtStack());
    }
    if (isTerminal(g, top.sym)) {
      if (top.sym === a) {
        stack.pop();
        const tok = tokens[pos]!;
        const leaf = tb.node(tok.name, true, tok);
        if (top.parent !== null) tb.attach(top.parent, leaf);
        pos++;
        tb.step({ action: 'match', detail: `match ${a} "${tok.text}"`, pos, stack: fmtStack() });
        continue;
      }
      return fail(tb, g, table, pos, tokens, [top.sym], rootId, fmtStack());
    }
    const ids = table.cells.get(top.sym)?.get(a) ?? [];
    if (ids.length === 0) {
      const expected = [...(table.cells.get(top.sym)?.keys() ?? [])];
      return fail(tb, g, table, pos, tokens, expected, rootId, fmtStack());
    }
    const p: Production = g.productions[ids[0]!]!;
    stack.pop();
    const children: Entry[] = p.rhs.map((s) => (isTerminal(g, s) ? { sym: s, node: null, parent: top.node } : { sym: s, node: tb.node(s, false), parent: top.node }));
    for (const c of children) if (c.node !== null && top.node !== null) tb.attach(top.node, c.node);
    for (let k = children.length - 1; k >= 0; k--) stack.push(children[k]!);
    tb.step({
      action: 'expand',
      detail: `M[${top.sym}, ${a}] = ${fmtProduction(g, p)}${ids.length > 1 ? `  (conflict: ${ids.length} choices, took the first)` : ''}`,
      pos,
      stack: fmtStack(),
      focus: { table: [top.sym, a], production: p.id },
    });
  }
  return { parser: 'll1', steps: tb.steps, accepted: false, treeOps: tb.treeOps, roots: [rootId], conflicts: table.conflicts, extra: table };
}

function fail(tb: TraceBuilder, _g: Grammar, table: Ll1Table, pos: number, tokens: LabToken[], expected: string[], rootId: number, stack: string[]): ParseResult {
  const tok = tokens[pos];
  const message = tok ? `unexpected ${tok.name} "${tok.text}" at token ${pos + 1}` : 'unexpected end of input';
  tb.step({ action: 'error', detail: `${message}; expected ${expected.join(', ')}`, pos, stack, error: { pos, message, expected } });
  return { parser: 'll1', steps: tb.steps, accepted: false, treeOps: tb.treeOps, roots: [rootId], conflicts: table.conflicts, error: { pos, message, expected }, extra: table };
}
