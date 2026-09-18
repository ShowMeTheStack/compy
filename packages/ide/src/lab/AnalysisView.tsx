import { useEffect, useMemo, useState } from 'react';
import { LabResult, Grammar, fmtProduction, fmtSymbol, TRANSFORMS, TransformId, transform, Check, Pda, fmtPdaConfig, LabToken, runPdaBounded } from '@compy/lab';
import { Diff } from '../OptView';
import { Automaton } from './Automaton';
import { Stepper } from './Stepper';

/**
 * Analysis panel: symbols and productions, the nullable/FIRST/FOLLOW
 * fixpoints replayed round by round, the structural checks with one-click
 * fixes, the transformations with diffs, and the grammar's pushdown
 * automaton with a configuration-set stepper.
 */
interface Props {
  result: LabResult;
  onApplyGrammar: (text: string) => void;
}

export function AnalysisView({ result, onApplyGrammar }: Props) {
  const [view, setView] = useState<'sets' | 'checks' | 'transform' | 'pda'>('sets');
  const g = result.grammar;
  if (!g || g.productions.length === 0) return <p className="hint">Write a grammar (stage: lexer + parser) to analyse it.</p>;
  return (
    <div className="analysis" data-testid="analysis">
      <div className="panel-toolbar">
        <span className="seg-toggle">
          <button className={view === 'sets' ? 'active' : ''} onClick={() => setView('sets')}>FIRST / FOLLOW</button>
          <button className={view === 'checks' ? 'active' : ''} onClick={() => setView('checks')}>checks</button>
          <button className={view === 'transform' ? 'active' : ''} onClick={() => setView('transform')}>transformations</button>
          <button className={view === 'pda' ? 'active' : ''} onClick={() => setView('pda')}>pushdown automaton</button>
        </span>
      </div>
      <Symbols g={g} />
      {view === 'sets' && result.analysis && <Sets g={g} an={result.analysis} />}
      {view === 'checks' && <Checks g={g} checks={result.checks} onApplyGrammar={onApplyGrammar} />}
      {view === 'transform' && <Transforms g={g} onApplyGrammar={onApplyGrammar} />}
      {view === 'pda' && result.pda && <PdaView pda={result.pda} g={g} tokens={result.tokens} />}
    </div>
  );
}

function Symbols({ g }: { g: Grammar }) {
  return (
    <div className="symbols">
      <span className="dim">start</span> <span className="sym nt">{g.start}</span>
      <span className="dim"> · nonterminals</span> {g.nonterminals.map((n) => <span key={n} className="sym nt">{n}</span>)}
      <span className="dim"> · terminals</span> {g.terminals.map((t) => <span key={t} className="sym t">{fmtSymbol(g, t)}</span>)}
      <span className="dim"> · {g.productions.length} productions</span>
    </div>
  );
}

function Sets({ g, an }: { g: Grammar; an: NonNullable<LabResult['analysis']> }) {
  const [which, setWhich] = useState<'first' | 'follow'>('first');
  const log = which === 'first' ? an.firstLog : an.followLog;
  const [round, setRound] = useState(log.rounds.length - 1);
  useEffect(() => setRound(log.rounds.length - 1), [log]);
  const r = Math.min(round, log.rounds.length - 1);
  const cur = log.rounds[r]!;
  const prev = r > 0 ? log.rounds[r - 1]! : null;
  return (
    <div className="sets">
      <div className="panel-toolbar">
        <span className="dim">nullable: {[...an.nullable].map((n) => <span key={n} className="sym nt">{n}</span>)}{an.nullable.size === 0 && '∅'}</span>
        <span className="spacer" />
        <span className="seg-toggle">
          <button className={which === 'first' ? 'active' : ''} onClick={() => setWhich('first')}>FIRST</button>
          <button className={which === 'follow' ? 'active' : ''} onClick={() => setWhich('follow')}>FOLLOW</button>
        </span>
      </div>
      <Stepper pos={r} count={log.rounds.length} onChange={setRound} label="iteration" testId="sets-stepper" />
      <p className="hint">
        {which === 'first'
          ? 'FIRST(A): the terminals that can begin a string derived from A. Each iteration re-applies every production until no set grows.'
          : 'FOLLOW(A): the terminals that can appear right after A in a sentential form; $ marks the end of input. Built from what follows each occurrence of A on a right-hand side.'}
        {' '}Newly added entries in this iteration are highlighted.
      </p>
      <table className="mem-table">
        <tbody>
          {g.nonterminals.map((nt) => (
            <tr key={nt}>
              <td className="sym nt">{which === 'first' ? 'FIRST' : 'FOLLOW'}({nt})</td>
              <td className="mono">
                {'{ '}
                {(cur.get(nt) ?? []).map((t) => (
                  <span key={t} className={`setitem ${prev && !prev.get(nt)?.includes(t) ? 'new' : ''}`}>
                    {fmtSymbol(g, t)}
                  </span>
                ))}
                {' }'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Checks({ g, checks, onApplyGrammar }: { g: Grammar; checks: Check[]; onApplyGrammar: (t: string) => void }) {
  const fixFor: Partial<Record<Check['kind'], TransformId>> = { 'left-recursion': 'left-recursion', 'common-prefix': 'left-factor', unreachable: 'useless', unproductive: 'useless' };
  return (
    <ul className="checks" data-testid="checks">
      {checks.map((c, k) => (
        <li key={k} className={`check ${c.kind}`}>
          <span className="check-kind">{c.kind === 'ok' ? '✓' : '!'}</span>
          <span>
            {c.message}
            {c.blocks.length > 0 && <span className="dim"> — blocks {c.blocks.join(', ')}</span>}
            {c.productions?.length ? <span className="dim"> — {c.productions.map((id) => fmtProduction(g, g.productions[id]!)).join('; ')}</span> : null}
          </span>
          {fixFor[c.kind] && (
            <button className="btn" onClick={() => onApplyGrammar(transform(g, fixFor[c.kind]!).after)}>
              fix: {TRANSFORMS.find((t) => t.id === fixFor[c.kind])!.name.toLowerCase()}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Transforms({ g, onApplyGrammar }: { g: Grammar; onApplyGrammar: (t: string) => void }) {
  const [sel, setSel] = useState<TransformId>('left-recursion');
  const r = useMemo(() => transform(g, sel), [g, sel]);
  const info = TRANSFORMS.find((t) => t.id === sel)!;
  return (
    <div className="transforms" data-testid="transforms">
      <div className="pass-list">
        {TRANSFORMS.map((t) => (
          <div key={t.id} className={`pass ${sel === t.id ? 'on' : ''}`} onClick={() => setSel(t.id)}>
            <label>
              <input type="radio" checked={sel === t.id} onChange={() => setSel(t.id)} /> {t.name}
            </label>
          </div>
        ))}
      </div>
      <p className="pass-desc">{info.description}</p>
      <ul className="notes">
        {r.notes.map((n, k) => (
          <li key={k}>{n}</li>
        ))}
      </ul>
      <Diff before={r.before} after={r.after} />
      <div className="panel-toolbar">
        <button className="btn run" onClick={() => onApplyGrammar(r.after)} disabled={r.before === r.after} data-testid="apply-transform">
          apply to grammar.cfg
        </button>
        {r.before === r.after && <span className="dim">no change</span>}
      </div>
    </div>
  );
}

function PdaView({ pda, g, tokens }: { pda: Pda; g: Grammar; tokens: LabToken[] }) {
  const [pos, setPos] = useState(0);
  const run = useMemo(() => runPdaBounded(pda, g, tokens), [pda, g, tokens]);
  useEffect(() => setPos(0), [run]);
  const nodes = pda.states.map((s, id) => ({ id, label: `q${id}`, sub: s.replace('q_', ''), accept: s === pda.accept, start: s === pda.start }));
  const byPair = new Map<string, number>();
  for (const t of pda.transitions) byPair.set(`${t.from}>${t.to}`, (byPair.get(`${t.from}>${t.to}`) ?? 0) + 1);
  const edges = [...byPair.entries()].map(([k, n]) => {
    const [from, to] = k.split('>');
    const tr = pda.transitions.filter((t) => t.from === from && t.to === to);
    return { from: pda.states.indexOf(from!), to: pda.states.indexOf(to!), label: n === 1 ? tr[0]!.label : `${n} transitions` };
  });
  const frontier = run?.frontiers[Math.min(pos, (run?.frontiers.length ?? 1) - 1)] ?? [];
  const onPath = new Set(run?.path.map((c) => c.id) ?? []);
  const leftRec = g.productions.some((p) => p.rhs[0] === p.lhs);
  return (
    <div className="pda" data-testid="pda">
      <p className="hint">
        The textbook CFG → PDA construction: push $ and the start symbol, then in q_loop either <b>expand</b> the nonterminal on top by one of its productions (an ε-move, nondeterministic) or <b>match</b> the terminal on top against the next input symbol. Reaching $ with the input consumed accepts.
      </p>
      <Automaton nodes={nodes} edges={edges} start={0} active={new Set(frontier.map((c) => pda.states.indexOf(c.state)))} compact />
      <table className="mem-table">
        <thead>
          <tr>
            <th>from</th>
            <th>read</th>
            <th>pop</th>
            <th>push</th>
            <th>to</th>
            <th>why</th>
          </tr>
        </thead>
        <tbody>
          {pda.transitions.map((t) => (
            <tr key={t.id}>
              <td className="mono">{t.from}</td>
              <td className="mono">{t.read ?? 'ε'}</td>
              <td className="mono">{t.pop ?? 'ε'}</td>
              <td className="mono">{t.push.length ? t.push.map((s) => fmtSymbol(g, s)).join(' ') : 'ε'}</td>
              <td className="mono">{t.to}</td>
              <td className="dim">{t.production !== undefined ? `expand by ${fmtProduction(g, g.productions[t.production]!)}` : t.read ? 'match input' : t.pop === '$' ? 'accept' : 'start'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {run && (
        <>
          <h3>Nondeterministic run on the input</h3>
          <Stepper pos={Math.min(pos, run.frontiers.length - 1)} count={run.frontiers.length} onChange={setPos} label="move" testId="pda-stepper" />
          <p className="hint">
            All configurations (state, remaining input, stack) alive after this many moves. {run.accepted ? 'The highlighted ones lie on an accepting path.' : run.truncated ? 'The frontier was cut off: a top-down PDA loops on left recursion — eliminate it first.' : 'No configuration accepts.'}
          </p>
          <div className="configs">
            {frontier.slice(0, 60).map((c) => (
              <span key={c.id} className={`config mono ${onPath.has(c.id) ? 'onpath' : ''}`}>
                {fmtPdaConfig(c, tokens)}
              </span>
            ))}
            {frontier.length > 60 && <span className="dim">… {frontier.length - 60} more</span>}
          </div>
          <div className={`verdict ${run.accepted ? 'yes' : 'no'}`}>{run.accepted ? 'accepted' : run.truncated ? 'gave up (frontier too large)' : 'rejected'}</div>
        </>
      )}
      {!run && <p className="hint">The PDA stepper runs for inputs of up to 40 tokens.</p>}
      {leftRec && <p className="hint">Note: this grammar is left-recursive. The top-down PDA can expand forever without reading input; the LR parsers (a bottom-up PDA) handle it fine.</p>}
    </div>
  );
}
