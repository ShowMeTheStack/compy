import { Grammar, isTerminal, fmtProduction } from '../grammar';
import { toCnf, isCnf } from '../transform';
import { LabToken } from '../lexer';
import { ParseResult, TraceBuilder } from '../trace';

/**
 * CYK: dynamic programming over spans of the input for a grammar in Chomsky
 * normal form. Cell (i, j) holds the nonterminals that derive tokens i..j;
 * it is filled from every split point k using the binary productions.
 */
export interface CykCell {
  entries: { nt: string; via: string; split?: number; left?: string; right?: string }[];
}
export interface CykTable {
  n: number;
  /** cells[i][len-1] for span starting at i of length len. */
  cells: CykCell[][];
  cnf: Grammar;
  converted: boolean;
  notes: string[];
}

export function cykParse(input: Grammar, tokens: LabToken[]): ParseResult {
  const tb = new TraceBuilder();
  let g = input;
  let converted = false;
  let notes: string[] = [];
  if (!isCnf(g)) {
    const r = toCnf(g);
    g = r.grammar;
    converted = true;
    notes = r.notes;
    tb.step({ action: 'cnf', detail: `grammar converted to Chomsky normal form (${g.productions.length} productions)`, pos: 0 });
  }
  const n = tokens.length;
  const cells: CykCell[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => ({ entries: [] })));
  const get = (i: number, len: number) => cells[i]![len - 1]!;
  // Length 1.
  for (let i = 0; i < n; i++) {
    const t = tokens[i]!.name;
    for (const p of g.productions) if (p.rhs.length === 1 && p.rhs[0] === t) get(i, 1).entries.push({ nt: p.lhs, via: fmtProduction(g, p) });
    tb.step({ action: 'fill', detail: `span [${i}, ${i}] = "${tokens[i]!.text}": {${get(i, 1).entries.map((e) => e.nt).join(', ') || '∅'}}`, pos: i + 1, focus: { cell: [i, 1] } });
  }
  for (let len = 2; len <= n; len++) {
    for (let i = 0; i + len <= n; i++) {
      const cell = get(i, len);
      for (let k = 1; k < len; k++) {
        const left = get(i, k);
        const right = get(i + k, len - k);
        for (const p of g.productions) {
          if (p.rhs.length !== 2) continue;
          const [B, C] = p.rhs as [string, string];
          if (left.entries.some((e) => e.nt === B) && right.entries.some((e) => e.nt === C) && !cell.entries.some((e) => e.nt === p.lhs)) {
            cell.entries.push({ nt: p.lhs, via: fmtProduction(g, p), split: k, left: B, right: C });
          }
        }
      }
      tb.step({ action: 'fill', detail: `span [${i}, ${i + len - 1}]: {${cell.entries.map((e) => `${e.nt}←${e.left}·${e.right}@${e.split}`).join(', ') || '∅'}}`, pos: i + len, focus: { cell: [i, len] } });
    }
  }
  const accepted = n === 0 ? g.productions.some((p) => p.lhs === g.start && p.rhs.length === 0) : get(0, n).entries.some((e) => e.nt === g.start);
  const roots: number[] = [];
  if (accepted && n > 0) {
    const build = (i: number, len: number, nt: string): number => {
      const e = get(i, len).entries.find((x) => x.nt === nt)!;
      const node = tb.node(nt, false);
      if (len === 1) tb.attach(node, tb.node(tokens[i]!.name, true, tokens[i]!));
      else {
        tb.attach(node, build(i, e.split!, e.left!));
        tb.attach(node, build(i + e.split!, len - e.split!, e.right!));
      }
      return node;
    };
    roots.push(build(0, n, g.start));
    tb.step({ action: 'accept', detail: `${g.start} ∈ cell [0, ${n - 1}]: accepted`, pos: n, focus: { cell: [0, n] } });
  } else if (accepted) {
    roots.push(tb.node(g.start, false));
    tb.step({ action: 'accept', detail: `${g.start} -> ε: the empty input is accepted`, pos: 0 });
  } else {
    const message = n === 0 ? 'empty input is not in the language' : `${g.start} ∉ cell [0, ${n - 1}]: rejected`;
    tb.step({ action: 'error', detail: message, pos: n, error: { pos: n, message, expected: [] }, focus: n ? { cell: [0, n] } : undefined });
    return { parser: 'cyk', steps: tb.steps, accepted: false, treeOps: tb.treeOps, roots, conflicts: [], error: { pos: n, message, expected: [] }, extra: { n, cells, cnf: g, converted, notes } satisfies CykTable };
  }
  return { parser: 'cyk', steps: tb.steps, accepted, treeOps: tb.treeOps, roots, conflicts: [], extra: { n, cells, cnf: g, converted, notes } satisfies CykTable };
}

export { isTerminal };
