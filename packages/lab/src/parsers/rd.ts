import { Grammar, Production, analyzeGrammar, firstOfSequence, isTerminal, fmtProduction, fmtSymbol, END } from '../grammar';
import { LabToken } from '../lexer';
import { ParseResult, TraceBuilder, Conflict } from '../trace';

/**
 * Recursive descent, generated from the grammar: one procedure per
 * nonterminal that picks an alternative by looking at the next token
 * (predictive parsing). The trace shows the procedure call stack and the
 * generated pseudocode with the current line highlighted — the way a
 * hand-written parser like Compy's own C parser works.
 */
export interface RdProgram {
  /** Pseudocode lines; `lineOf` maps (production id, position) to a line. */
  lines: string[];
  procStart: Map<string, number>;
  lineOf: Map<string, number>;
  conflicts: Conflict[];
}

export function generateRd(g: Grammar): RdProgram {
  const an = analyzeGrammar(g);
  const lines: string[] = [];
  const procStart = new Map<string, number>();
  const lineOf = new Map<string, number>();
  const conflicts: Conflict[] = [];
  for (const nt of g.nonterminals) {
    procStart.set(nt, lines.length);
    lines.push(`procedure ${nt}():`);
    const ps = g.productions.filter((p) => p.lhs === nt);
    const seen = new Map<string, number>();
    ps.forEach((p, k) => {
      const f = firstOfSequence(p.rhs, an.first, an.nullable);
      const look = new Set(f.set);
      if (f.nullable) for (const t of an.follow.get(nt) ?? []) look.add(t);
      for (const t of look) {
        const prev = seen.get(t);
        if (prev !== undefined) conflicts.push({ kind: 'choice', where: `${nt}() on ${t}`, symbol: t, message: `${nt}(): both "${fmtProduction(g, g.productions[prev]!)}" and "${fmtProduction(g, p)}" can start with ${t}; the first wins` });
        else seen.set(t, p.id);
      }
      lineOf.set(`${p.id}.head`, lines.length);
      lines.push(`  ${k === 0 ? 'if' : 'else if'} lookahead in {${[...look].map((t) => fmtSymbol(g, t)).join(', ')}}:   # ${fmtProduction(g, p)}`);
      if (p.rhs.length === 0) {
        lineOf.set(`${p.id}.0`, lines.length);
        lines.push(`    pass   # ε`);
      }
      p.rhs.forEach((s, j) => {
        lineOf.set(`${p.id}.${j}`, lines.length);
        lines.push(isTerminal(g, s) ? `    expect(${fmtSymbol(g, s)})` : `    ${s}()`);
      });
    });
    lineOf.set(`${nt}.else`, lines.length);
    lines.push(`  else: syntax error`);
    lines.push('');
  }
  return { lines, procStart, lineOf, conflicts };
}

export function rdParse(g: Grammar, tokens: LabToken[]): ParseResult {
  const prog = generateRd(g);
  const an = analyzeGrammar(g);
  const tb = new TraceBuilder();
  const input = [...tokens.map((t) => t.name), END];
  let pos = 0;
  const callStack: string[] = [];
  let error: ParseResult['error'] | undefined;
  let depth = 0;
  const chooser = new Map<string, { prod: Production; look: Set<string> }[]>();
  for (const nt of g.nonterminals) {
    chooser.set(nt, g.productions.filter((p) => p.lhs === nt).map((p) => {
      const f = firstOfSequence(p.rhs, an.first, an.nullable);
      const look = new Set(f.set);
      if (f.nullable) for (const t of an.follow.get(nt) ?? []) look.add(t);
      return { prod: p, look };
    }));
  }
  const parse = (nt: string): number | null => {
    if (++depth > 2000) {
      error = { pos, message: 'recursion too deep (left recursion?)', expected: [] };
      return null;
    }
    callStack.push(nt + '()');
    const node = tb.node(nt, false);
    tb.step({ action: 'call', detail: `${nt}() with lookahead ${input[pos]}`, pos, callStack: callStack.slice(), focus: { line: prog.procStart.get(nt) } });
    const choice = chooser.get(nt)!.find((c) => c.look.has(input[pos]!));
    if (!choice) {
      const expected = [...new Set(chooser.get(nt)!.flatMap((c) => [...c.look]))];
      const tok = tokens[pos];
      const message = tok ? `${nt}(): unexpected ${tok.name} "${tok.text}" at token ${pos + 1}` : `${nt}(): unexpected end of input`;
      error = { pos, message, expected };
      tb.step({ action: 'error', detail: `${message}; expected one of ${expected.join(', ')}`, pos, callStack: callStack.slice(), focus: { line: prog.lineOf.get(`${nt}.else`) }, error });
      callStack.pop();
      return node;
    }
    const p = choice.prod;
    tb.step({ action: 'choose', detail: `lookahead ${input[pos]} selects ${fmtProduction(g, p)}`, pos, callStack: callStack.slice(), focus: { line: prog.lineOf.get(`${p.id}.head`), production: p.id } });
    if (p.rhs.length === 0) tb.step({ action: 'epsilon', detail: `${nt} -> ε: consume nothing`, pos, callStack: callStack.slice(), focus: { line: prog.lineOf.get(`${p.id}.0`) } });
    for (let j = 0; j < p.rhs.length; j++) {
      const s = p.rhs[j]!;
      if (isTerminal(g, s)) {
        if (input[pos] === s) {
          const tok = tokens[pos]!;
          const leaf = tb.node(tok.name, true, tok);
          tb.attach(node, leaf);
          pos++;
          tb.step({ action: 'match', detail: `expect(${s}) matched "${tok.text}"`, pos, callStack: callStack.slice(), focus: { line: prog.lineOf.get(`${p.id}.${j}`) } });
        } else {
          const tok = tokens[pos];
          const message = tok ? `expected ${s} but found ${tok.name} "${tok.text}" at token ${pos + 1}` : `expected ${s} but reached the end of input`;
          error = { pos, message, expected: [s] };
          tb.step({ action: 'error', detail: message, pos, callStack: callStack.slice(), focus: { line: prog.lineOf.get(`${p.id}.${j}`) }, error });
          callStack.pop();
          return node;
        }
      } else {
        const child = parse(s);
        if (child !== null) tb.attach(node, child);
        if (error) {
          callStack.pop();
          return node;
        }
      }
    }
    callStack.pop();
    depth--;
    tb.step({ action: 'return', detail: `return from ${nt}()`, pos, callStack: callStack.slice(), focus: { line: prog.procStart.get(nt) } });
    return node;
  };
  const root = parse(g.start);
  let accepted = false;
  if (!error) {
    if (input[pos] === END) {
      accepted = true;
      tb.step({ action: 'accept', detail: 'all input consumed: accepted', pos, callStack: [] });
    } else {
      const tok = tokens[pos]!;
      error = { pos, message: `trailing input: ${tok.name} "${tok.text}" at token ${pos + 1}`, expected: [END] };
      tb.step({ action: 'error', detail: error.message, pos, callStack: [], error });
    }
  }
  return { parser: 'rd', steps: tb.steps, accepted, treeOps: tb.treeOps, roots: root === null ? [] : [root], conflicts: prog.conflicts, error, extra: prog };
}
