import { useEffect, useMemo, useState } from 'react';
import {
  LabResult, LabToken, ParseResult, ParseStep, Grammar, ParserId, PARSERS, fmtProduction, fmtSymbol, END,
  Ll1Table, RdProgram, LrTables, fmtLrItem, fmtAction, EarleyChart, fmtItem, CykTable, OpTable, buildTree, fmtTree,
} from '@compy/lab';
import { Automaton } from './Automaton';
import { Stepper } from './Stepper';
import { ParseTree } from './TreeView';
import { EditorRange } from '../Editor';

/**
 * Parse panel: choose a parser, see its tables / item sets / chart /
 * pseudocode, and step through the parse with the stack, the input cursor,
 * the structure in focus, and the tree growing alongside.
 */
interface Props {
  result: LabResult;
  input: string;
  parser: ParserId;
  onParserChange: (p: ParserId) => void;
  pos: number;
  onPos: (p: number) => void;
  onHover: (r: EditorRange | null) => void;
  showTree: boolean;
}

export function tokenRange(input: string, t: LabToken): EditorRange {
  const lc = (p: number) => {
    const before = input.slice(0, p);
    return { line: before.split('\n').length, col: p - (before.lastIndexOf('\n') + 1) + 1 };
  };
  const a = lc(t.start);
  const b = lc(Math.max(t.start, t.end - 1));
  return { line: a.line, col: a.col, endLine: b.line, endCol: b.col };
}

export function ParseView({ result, input, parser, onParserChange, pos, onPos, onHover, showTree }: Props) {
  const pr = result.parse;
  const g = result.grammar;
  const steps = pr?.steps ?? [];
  const step: ParseStep | undefined = steps[Math.min(pos, Math.max(0, steps.length - 1))];
  const info = PARSERS.find((p) => p.id === parser)!;
  // The result may still belong to the previously selected parser while the
  // debounced recompute runs: always render structures for the result's parser.
  const shown = (pr?.parser ?? parser) as ParserId;
  const stale = pr !== null && pr.parser !== parser;
  const tree = useMemo(() => (pr && step ? buildTree(pr.treeOps, step.treeOpsUpTo) : null), [pr, step]);
  useEffect(() => {
    if (step && result.tokens[step.pos]) onHover(tokenRange(input, result.tokens[step.pos]!));
    else onHover(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  return (
    <div className="parseview" data-testid="parse">
      <div className="panel-toolbar">
        <select value={parser} onChange={(e) => onParserChange(e.target.value as ParserId)} data-testid="parser-select">
          {['top-down', 'bottom-up', 'general', 'expressions'].map((fam) => (
            <optgroup key={fam} label={fam}>
              {PARSERS.filter((p) => p.family === fam).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="dim">{info.description}</span>
      </div>
      {result.problems.filter((p) => p.phase === 'parser').map((p, k) => (
        <div key={k} className="fault-banner">{p.message}</div>
      ))}
      {!pr && !result.problems.some((p) => p.phase === 'parser') && <p className="hint">Set the stage to “lexer + parser” and write a grammar.</p>}
      {stale && <p className="hint">recomputing with {info.name}…</p>}
      {pr && g && (
        <>
          {pr.conflicts.length > 0 && (
            <div className="conflicts" data-testid="conflicts">
              {pr.conflicts.map((c, k) => (
                <div key={k} className="conflict">
                  <b>{c.kind}</b> {c.message}
                </div>
              ))}
            </div>
          )}
          <TokenStrip tokens={result.tokens} pos={step?.pos ?? 0} input={input} onHover={onHover} />
          <Stepper pos={Math.min(pos, steps.length - 1)} count={steps.length} onChange={onPos} testId="parse-stepper" />
          {step && (
            <div className={`step-detail action-${step.action} ${step.error ? 'error' : ''}`} data-testid="parse-step">
              <span className="action-badge">{step.action}</span> {step.detail}
            </div>
          )}
          <div className={`verdict ${pr.accepted ? 'yes' : 'no'}`} data-testid="parse-verdict">
            {pr.accepted ? `accepted${pr.parses && pr.parses > 1 ? ` (${pr.parses} parse trees)` : ''}` : `rejected: ${pr.error?.message ?? ''}`}
          </div>
          {step?.stack && <StackBox title={parser === 'opprec' ? 'stacks' : 'stack'} items={step.stack} />}
          {step?.callStack && <CallStackBox items={step.callStack} />}
          <Structure parser={shown} pr={pr} g={g} step={step} />
          {showTree && tree && (
            <>
              <h3>Parse tree so far</h3>
              {shown === 'earley' && tree.roots.length === 0 && <p className="hint">Earley records derivations in the chart and builds the tree when the input is accepted: step to the end.</p>}
              {shown === 'cyk' && tree.roots.length === 0 && <p className="hint">CYK fills the table first and reads the tree back from the top cell at the end.</p>}
              <ParseTree nodes={tree.nodes} roots={tree.roots} compact />
              {tree.roots.length === 1 && <div className="mono dim sentential">{fmtTree(tree.nodes, tree.roots[0]!)}</div>}
            </>
          )}
        </>
      )}
    </div>
  );
}

function TokenStrip({ tokens, pos, input, onHover }: { tokens: LabToken[]; pos: number; input: string; onHover: (r: EditorRange | null) => void }) {
  return (
    <div className="token-strip" onMouseLeave={() => onHover(null)}>
      {tokens.map((t, k) => (
        <span key={k} className={`tok ${k < pos ? 'consumed' : k === pos ? 'cursor' : ''}`} onMouseEnter={() => onHover(tokenRange(input, t))} title={t.name}>
          {t.text === t.name ? t.name : `${t.name}(${t.text})`}
        </span>
      ))}
      <span className={`tok end ${pos >= tokens.length ? 'cursor' : ''}`}>$</span>
    </div>
  );
}

function StackBox({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="stackbox">
      <span className="dim">{title}:</span>
      <div className="stack-cells">
        {items.map((s, k) => (
          <span key={k} className={`stack-cell ${k === items.length - 1 ? 'top' : ''}`}>
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}
function CallStackBox({ items }: { items: string[] }) {
  return (
    <div className="stackbox">
      <span className="dim">calls:</span>
      <div className="stack-cells vertical">
        {items.map((s, k) => (
          <span key={k} className={`stack-cell ${k === items.length - 1 ? 'top' : ''}`}>
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

function Structure({ parser, pr, g, step }: { parser: ParserId; pr: ParseResult; g: Grammar; step?: ParseStep }) {
  switch (parser) {
    case 'rd': return <RdView prog={pr.extra as RdProgram} step={step} />;
    case 'll1': return <Ll1View table={pr.extra as Ll1Table} g={g} step={step} />;
    case 'lr0': case 'slr1': case 'lr1': case 'lalr1': return <LrView tables={pr.extra as LrTables} step={step} />;
    case 'earley': return <EarleyView chart={pr.extra as EarleyChart} g={g} step={step} />;
    case 'cyk': return <CykView table={pr.extra as CykTable} step={step} />;
    case 'opprec': return <OpView table={pr.extra as OpTable} g={g} />;
  }
}

function RdView({ prog, step }: { prog: RdProgram; step?: ParseStep }) {
  return (
    <div>
      <h3>Generated parser</h3>
      <pre className="pseudocode" data-testid="pseudocode">
        {prog.lines.map((l, k) => (
          <div key={k} className={`code-line ${step?.focus?.line === k ? 'current' : ''}`}>
            {l}
          </div>
        ))}
      </pre>
    </div>
  );
}

function Ll1View({ table, g, step }: { table: Ll1Table; g: Grammar; step?: ParseStep }) {
  const focus = step?.focus?.table;
  return (
    <div>
      <h3>Predict table M[nonterminal, lookahead]</h3>
      <div className="table-scroll">
        <table className="mem-table ptable" data-testid="ll1-table">
          <thead>
            <tr>
              <th />
              {table.terminals.map((t) => (
                <th key={t} className="mono">
                  {fmtSymbol(g, t)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {g.nonterminals.map((nt) => (
              <tr key={nt}>
                <td className="sym nt">{nt}</td>
                {table.terminals.map((t) => {
                  const ids = table.cells.get(nt)?.get(t) ?? [];
                  const hot = focus && focus[0] === nt && focus[1] === t;
                  return (
                    <td key={t} className={`mono ${ids.length > 1 ? 'conflict' : ''} ${hot ? 'hot' : ''}`} title={ids.map((id) => fmtProduction(g, g.productions[id]!)).join(' | ')}>
                      {ids.map((id) => (g.productions[id]!.rhs.length ? g.productions[id]!.rhs.map((s) => fmtSymbol(g, s)).join(' ') : 'ε')).join(' | ')}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LrView({ tables, step }: { tables: LrTables; step?: ParseStep }) {
  const [view, setView] = useState<'items' | 'graph' | 'table'>('graph');
  const g = tables.grammar;
  const cur = step?.focus?.itemSet;
  const nodes = tables.states.map((s) => ({ id: s.id, label: `I${s.id}`, start: s.id === 0, accept: s.items.some((it) => it.prod === 0 && it.dot === 1) }));
  const edges: { from: number; to: number; label: string }[] = [];
  for (const [from, m] of tables.gotoGraph) for (const [sym, to] of m) edges.push({ from, to, label: sym });
  const focusCell = step?.focus?.table;
  return (
    <div>
      <div className="panel-toolbar">
        <span className="seg-toggle">
          <button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')}>goto graph</button>
          <button className={view === 'items' ? 'active' : ''} onClick={() => setView('items')}>item sets</button>
          <button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>ACTION / GOTO</button>
        </span>
        <span className="dim">
          {tables.states.length} states{tables.lr1States ? ` (merged from ${tables.lr1States} LR(1) states)` : ''} · {tables.conflicts.length} conflict(s)
        </span>
      </div>
      {view === 'graph' && (
        <>
          <Automaton nodes={nodes} edges={edges} start={0} active={new Set(cur !== undefined ? [cur] : [])} compact={tables.states.length > 10} testId="goto-graph" />
          {cur !== undefined && <ItemSet tables={tables} id={cur} highlight />}
        </>
      )}
      {view === 'items' && (
        <div className="itemsets">
          {tables.states.map((s) => (
            <ItemSet key={s.id} tables={tables} id={s.id} highlight={s.id === cur} />
          ))}
        </div>
      )}
      {view === 'table' && (
        <div className="table-scroll">
          <table className="mem-table ptable" data-testid="lr-table">
            <thead>
              <tr>
                <th>state</th>
                {tables.terminals.map((t) => (
                  <th key={t} className="mono">
                    {fmtSymbol(g, t)}
                  </th>
                ))}
                <th className="sep" />
                {tables.nonterminals.map((n) => (
                  <th key={n} className="sym nt">
                    {n}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tables.states.map((s) => (
                <tr key={s.id} className={s.id === cur ? 'hot-row' : ''}>
                  <td className="mono">I{s.id}</td>
                  {tables.terminals.map((t) => {
                    const list = tables.action.get(s.id)?.get(t) ?? [];
                    const hot = focusCell && focusCell[0] === String(s.id) && focusCell[1] === t;
                    return (
                      <td key={t} className={`mono ${list.length > 1 ? 'conflict' : ''} ${hot ? 'hot' : ''}`} title={list.map((a) => fmtAction(g, a)).join(' / ')}>
                        {list.map((a) => (a.kind === 'shift' ? `s${a.to}` : a.kind === 'accept' ? 'acc' : `r${a.prod}`)).join('/')}
                      </td>
                    );
                  })}
                  <td className="sep" />
                  {tables.nonterminals.map((n) => (
                    <td key={n} className="mono">
                      {tables.gotoGraph.get(s.id)?.get(n) ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">s = shift to state, r = reduce by production number, acc = accept. Red cells hold more than one action: a conflict.</p>
        </div>
      )}
    </div>
  );
}

function ItemSet({ tables, id, highlight }: { tables: LrTables; id: number; highlight: boolean }) {
  const s = tables.states[id]!;
  return (
    <div className={`itemset ${highlight ? 'hot' : ''}`} data-testid={`itemset-${id}`}>
      <div className="itemset-title">
        I{id}
        {s.mergedFrom && s.mergedFrom.length > 1 && <span className="dim"> (merged LR(1) states {s.mergedFrom.join(', ')})</span>}
      </div>
      {s.items.map((it, k) => (
        <div key={k} className={`item mono ${k < s.kernel ? 'kernel' : 'closure'}`}>
          {fmtLrItem(tables.grammar, it)}
        </div>
      ))}
    </div>
  );
}

function EarleyView({ chart, g, step }: { chart: EarleyChart; g: Grammar; step?: ParseStep }) {
  const col = step?.focus?.column;
  // Only items added up to this step are shown, so the chart fills in as you step.
  const stepIndex = step?.index ?? Infinity;
  return (
    <div className="chart" data-testid="chart">
      {chart.columns.map((items, k) => (
        <div key={k} className={`chart-col ${k === col ? 'hot' : ''}`}>
          <div className="chart-title">S{k}</div>
          {items.filter((it) => it.id <= stepIndex).map((it) => (
            <div key={it.id} className={`item mono via-${it.via} ${it.dot >= it.prod.rhs.length ? 'complete' : ''}`} title={it.via}>
              {fmtItem(g, it)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function CykView({ table, step }: { table: CykTable; step?: ParseStep }) {
  const focus = step?.focus?.cell;
  const n = table.n;
  if (n === 0) return <p className="hint">Empty input.</p>;
  return (
    <div>
      {table.converted && <p className="hint">Converted to Chomsky normal form first: {table.notes.join('; ')}</p>}
      <div className="cyk" data-testid="cyk">
        {Array.from({ length: n }, (_, row) => {
          const len = n - row;
          return (
            <div key={len} className="cyk-row" style={{ paddingLeft: `${(row * 50) / 2}px` }}>
              {Array.from({ length: n - len + 1 }, (_, i) => {
                const cell = table.cells[i]![len - 1]!;
                const hot = focus && focus[0] === i && focus[1] === len;
                const filled = !step || step.index >= 0;
                return (
                  <div key={i} className={`cyk-cell ${hot ? 'hot' : ''} ${cell.entries.length ? 'filled' : ''}`} title={`span [${i}, ${i + len - 1}]: ${cell.entries.map((e) => e.via).join('; ') || '∅'}`}>
                    {filled && cell.entries.map((e) => e.nt).join(' ')}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <p className="hint">Bottom row: single tokens. Each cell above combines two cells below it through a binary production; the top cell must contain the start symbol.</p>
    </div>
  );
}

function OpView({ table, g }: { table: OpTable; g: Grammar }) {
  return (
    <div>
      <h3>Operator table</h3>
      <table className="mem-table">
        <thead>
          <tr>
            <th>operator</th>
            <th>level</th>
            <th>associativity</th>
          </tr>
        </thead>
        <tbody>
          {table.ops.map((o) => (
            <tr key={o.symbol}>
              <td className="mono">{fmtSymbol(g, o.symbol)}</td>
              <td className="mono">{o.level}</td>
              <td>{o.assoc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Operands: {table.operands.map((t) => fmtSymbol(g, t)).join(', ') || 'none'}. Higher level binds tighter; a right-associative operator parses its right side with the same minimum precedence, a left-associative one with level + 1.</p>
    </div>
  );
}

export { END };
