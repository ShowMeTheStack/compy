import { Grammar, Production, analyzeGrammar, firstOfSequence, isTerminal, fmtProduction, END } from '../grammar';
import { augment } from '../transform';
import { LabToken } from '../lexer';
import { ParseResult, TraceBuilder, Conflict } from '../trace';

/**
 * The LR family. All four variants share the item-set machinery, the goto
 * graph, the ACTION/GOTO tables and the shift/reduce driver; they differ
 * only in how reductions get their lookaheads:
 *   LR(0)   reduce on every terminal (no lookahead at all)
 *   SLR(1)  reduce on FOLLOW(A)
 *   LR(1)   reduce on the lookaheads carried by the LR(1) items
 *   LALR(1) LR(1) states with equal cores merged, lookaheads unioned
 */
export type LrKind = 'lr0' | 'slr1' | 'lr1' | 'lalr1';

export interface LrItem {
  prod: number;
  dot: number;
  /** LR(1)/LALR(1) lookaheads (empty for LR(0)/SLR). */
  la: string[];
}
export interface LrState {
  id: number;
  items: LrItem[];
  /** Kernel items (the ones not added by closure), for display. */
  kernel: number;
  /** For LALR: the LR(1) state ids merged into this one. */
  mergedFrom?: number[];
}
export interface LrAction {
  kind: 'shift' | 'reduce' | 'accept';
  to?: number;
  prod?: number;
}
export interface LrTables {
  kind: LrKind;
  grammar: Grammar; // augmented
  states: LrState[];
  /** state → symbol → next state. */
  gotoGraph: Map<number, Map<string, number>>;
  /** state → terminal → actions (more than one = conflict). */
  action: Map<number, Map<string, LrAction[]>>;
  conflicts: Conflict[];
  terminals: string[];
  nonterminals: string[];
  /** LR(1) state count before merging (LALR only). */
  lr1States?: number;
}

function itemKey(it: LrItem, withLa: boolean): string {
  return withLa ? `${it.prod}.${it.dot}|${[...it.la].sort().join(',')}` : `${it.prod}.${it.dot}`;
}

export function fmtLrItem(g: Grammar, it: LrItem): string {
  const p = g.productions[it.prod]!;
  const rhs = p.rhs.map((s, k) => (k === it.dot ? '• ' : '') + s);
  const body = it.dot >= p.rhs.length ? (rhs.length ? rhs.join(' ') + ' •' : '•') : rhs.join(' ');
  return `${p.lhs} -> ${body}${it.la.length ? `, ${it.la.join('/')}` : ''}`;
}

export function buildLrTables(input: Grammar, kind: LrKind): LrTables {
  const g = augment(input).grammar;
  const an = analyzeGrammar(g);
  const useLa = kind === 'lr1' || kind === 'lalr1';
  const closure = (items: LrItem[]): LrItem[] => {
    const out: LrItem[] = items.map((i) => ({ ...i, la: i.la.slice() }));
    const index = new Map<string, LrItem>();
    for (const it of out) index.set(`${it.prod}.${it.dot}`, it);
    for (let k = 0; k < out.length; k++) {
      const it = out[k]!;
      const p = g.productions[it.prod]!;
      const next = p.rhs[it.dot];
      if (next === undefined || isTerminal(g, next)) continue;
      // Lookaheads for the new items: FIRST(β a) for each a in it.la.
      let las: string[] = [];
      if (useLa) {
        const beta = p.rhs.slice(it.dot + 1);
        const f = firstOfSequence(beta, an.first, an.nullable);
        las = [...f.set];
        if (f.nullable) for (const a of it.la) if (!las.includes(a)) las.push(a);
      }
      for (const q of g.productions) {
        if (q.lhs !== next) continue;
        const key = `${q.id}.0`;
        const existing = index.get(key);
        if (existing) {
          if (useLa) for (const a of las) if (!existing.la.includes(a)) {
            existing.la.push(a);
            // Lookaheads grew: items derived from this one must be revisited.
            k = Math.min(k, out.indexOf(existing) - 1);
          }
        } else {
          const ni: LrItem = { prod: q.id, dot: 0, la: useLa ? las.slice() : [] };
          out.push(ni);
          index.set(key, ni);
        }
      }
    }
    return out;
  };
  const gotoSet = (items: LrItem[], sym: string): LrItem[] => closure(items.filter((it) => g.productions[it.prod]!.rhs[it.dot] === sym).map((it) => ({ prod: it.prod, dot: it.dot + 1, la: it.la.slice() })));
  const stateKey = (items: LrItem[], kernelOnly: number) => items.slice(0, kernelOnly).map((it) => itemKey(it, useLa)).sort().join(';');

  const states: LrState[] = [];
  const gotoGraph = new Map<number, Map<string, number>>();
  const keyIndex = new Map<string, number>();
  const startItems = closure([{ prod: 0, dot: 0, la: useLa ? [END] : [] }]);
  states.push({ id: 0, items: startItems, kernel: 1 });
  keyIndex.set(stateKey(startItems, 1), 0);
  const symbols = [...g.terminals, ...g.nonterminals];
  for (let s = 0; s < states.length; s++) {
    const st = states[s]!;
    gotoGraph.set(s, new Map());
    for (const sym of symbols) {
      const kernel = st.items.filter((it) => g.productions[it.prod]!.rhs[it.dot] === sym);
      if (!kernel.length) continue;
      const items = gotoSet(st.items, sym);
      const key = stateKey(items, kernel.length);
      let t = keyIndex.get(key);
      if (t === undefined) {
        t = states.length;
        states.push({ id: t, items, kernel: kernel.length });
        keyIndex.set(key, t);
      }
      gotoGraph.get(s)!.set(sym, t);
    }
  }
  let lr1States: number | undefined;
  let finalStates = states;
  let finalGoto = gotoGraph;
  if (kind === 'lalr1') {
    lr1States = states.length;
    // Merge states with identical cores.
    const coreKey = (st: LrState) => st.items.slice(0, st.kernel).map((it) => `${it.prod}.${it.dot}`).sort().join(';');
    const groups = new Map<string, number[]>();
    for (const st of states) groups.set(coreKey(st), [...(groups.get(coreKey(st)) ?? []), st.id]);
    const newId = new Map<number, number>();
    const merged: LrState[] = [];
    for (const ids of groups.values()) {
      const id = merged.length;
      const base = states[ids[0]!]!;
      const items = base.items.map((it) => ({ ...it, la: it.la.slice() }));
      for (const other of ids.slice(1)) {
        for (const it of states[other]!.items) {
          const mine = items.find((x) => x.prod === it.prod && x.dot === it.dot);
          if (mine) for (const a of it.la) if (!mine.la.includes(a)) mine.la.push(a);
        }
      }
      merged.push({ id, items, kernel: base.kernel, mergedFrom: ids });
      for (const o of ids) newId.set(o, id);
    }
    // Reorder so that state 0 stays the start state.
    const startNew = newId.get(0)!;
    const order = [startNew, ...merged.map((m) => m.id).filter((x) => x !== startNew)];
    const rename = new Map(order.map((old, k) => [old, k] as const));
    finalStates = order.map((old, k) => ({ ...merged[old]!, id: k }));
    finalGoto = new Map();
    for (const [s, m] of gotoGraph) {
      const ns = rename.get(newId.get(s)!)!;
      let row = finalGoto.get(ns);
      if (!row) finalGoto.set(ns, (row = new Map()));
      for (const [sym, t] of m) row.set(sym, rename.get(newId.get(t)!)!);
    }
  }
  // Tables.
  const action = new Map<number, Map<string, LrAction[]>>();
  const conflicts: Conflict[] = [];
  const terminals = [...g.terminals, END];
  for (const st of finalStates) {
    const row = new Map<string, LrAction[]>();
    action.set(st.id, row);
    const put = (t: string, a: LrAction) => {
      const list = row.get(t) ?? [];
      if (!list.some((x) => x.kind === a.kind && x.to === a.to && x.prod === a.prod)) list.push(a);
      row.set(t, list);
    };
    for (const [sym, t] of finalGoto.get(st.id) ?? []) if (isTerminal(g, sym)) put(sym, { kind: 'shift', to: t });
    for (const it of st.items) {
      const p = g.productions[it.prod]!;
      if (it.dot < p.rhs.length) continue;
      if (p.id === 0) {
        put(END, { kind: 'accept' });
        continue;
      }
      const las = kind === 'lr0' ? terminals : kind === 'slr1' ? [...(an.follow.get(p.lhs) ?? [])] : it.la;
      for (const a of las) put(a, { kind: 'reduce', prod: p.id });
    }
    for (const [t, list] of row) {
      if (list.length < 2) continue;
      const kinds = list.map((a) => a.kind);
      const kindName: Conflict['kind'] = kinds.includes('shift') ? 'shift/reduce' : 'reduce/reduce';
      conflicts.push({
        kind: kindName,
        where: `state ${st.id} on ${t}`,
        state: st.id,
        symbol: t,
        message: `${kindName} conflict in state ${st.id} on ${t}: ${list.map((a) => fmtAction(g, a)).join('  vs  ')}`,
      });
    }
  }
  return { kind, grammar: g, states: finalStates, gotoGraph: finalGoto, action, conflicts, terminals, nonterminals: g.nonterminals.slice(1), lr1States };
}

export function fmtAction(g: Grammar, a: LrAction): string {
  if (a.kind === 'shift') return `s${a.to}`;
  if (a.kind === 'accept') return 'acc';
  return `r${a.prod} (${fmtProduction(g, g.productions[a.prod!]!)})`;
}

export function lrParse(input: Grammar, tokens: LabToken[], kind: LrKind): ParseResult {
  const tables = buildLrTables(input, kind);
  const g = tables.grammar;
  const tb = new TraceBuilder();
  const inp = [...tokens.map((t) => t.name), END];
  const stateStack: number[] = [0];
  const symStack: { sym: string; node: number }[] = [];
  let pos = 0;
  const fmtStack = () => ['0', ...symStack.map((s, k) => `${s.sym} ${stateStack[k + 1]}`)];
  tb.step({ action: 'init', detail: 'start in state 0', pos, stack: fmtStack(), focus: { itemSet: 0 } });
  for (let guard = 0; guard < 200000; guard++) {
    const s = stateStack[stateStack.length - 1]!;
    const a = inp[pos]!;
    const list = tables.action.get(s)?.get(a) ?? [];
    if (list.length === 0) {
      const expected = [...(tables.action.get(s)?.keys() ?? [])];
      const tok = tokens[pos];
      const message = tok ? `unexpected ${tok.name} "${tok.text}" at token ${pos + 1} in state ${s}` : `unexpected end of input in state ${s}`;
      tb.step({ action: 'error', detail: `${message}; expected ${expected.join(', ')}`, pos, stack: fmtStack(), focus: { itemSet: s, table: [String(s), a] }, error: { pos, message, expected } });
      return { parser: kind, steps: tb.steps, accepted: false, treeOps: tb.treeOps, roots: symStack.map((x) => x.node), conflicts: tables.conflicts, error: { pos, message, expected }, extra: tables };
    }
    // Default conflict resolution: shift over reduce, first reduce otherwise.
    const act = list.find((x) => x.kind === 'shift') ?? list.find((x) => x.kind === 'accept') ?? list[0]!;
    const conflictNote = list.length > 1 ? ` (conflict: ${list.map((x) => fmtAction(g, x)).join(' / ')}; took ${fmtAction(g, act)})` : '';
    if (act.kind === 'shift') {
      const tok = tokens[pos]!;
      const node = tb.node(tok.name, true, tok);
      symStack.push({ sym: a, node });
      stateStack.push(act.to!);
      pos++;
      tb.step({ action: 'shift', detail: `shift ${a} "${tok.text}", go to state ${act.to}${conflictNote}`, pos, stack: fmtStack(), focus: { itemSet: act.to, table: [String(s), a] } });
    } else if (act.kind === 'reduce') {
      const p = g.productions[act.prod!]!;
      const node = tb.node(p.lhs, false);
      const popped = symStack.splice(symStack.length - p.rhs.length, p.rhs.length);
      stateStack.splice(stateStack.length - p.rhs.length, p.rhs.length);
      for (const x of popped) tb.attach(node, x.node);
      const top = stateStack[stateStack.length - 1]!;
      const next = tables.gotoGraph.get(top)?.get(p.lhs);
      if (next === undefined) {
        const message = `no GOTO[${top}, ${p.lhs}]`;
        tb.step({ action: 'error', detail: message, pos, stack: fmtStack(), error: { pos, message, expected: [] } });
        return { parser: kind, steps: tb.steps, accepted: false, treeOps: tb.treeOps, roots: [node], conflicts: tables.conflicts, error: { pos, message, expected: [] }, extra: tables };
      }
      symStack.push({ sym: p.lhs, node });
      stateStack.push(next);
      tb.step({ action: 'reduce', detail: `reduce by ${fmtProduction(g, p)}; GOTO[${top}, ${p.lhs}] = ${next}${conflictNote}`, pos, stack: fmtStack(), focus: { itemSet: next, table: [String(s), a], production: p.id } });
    } else {
      tb.step({ action: 'accept', detail: 'accept', pos, stack: fmtStack(), focus: { itemSet: s, table: [String(s), END] } });
      return { parser: kind, steps: tb.steps, accepted: true, treeOps: tb.treeOps, roots: symStack.map((x) => x.node), conflicts: tables.conflicts, extra: tables };
    }
  }
  return { parser: kind, steps: tb.steps, accepted: false, treeOps: tb.treeOps, roots: [], conflicts: tables.conflicts, extra: tables };
}

export type { Production };
