import { useMemo, useState } from 'react';
import { CompiledLexer, CompiledState, Nfa, Dfa, parseRegex, thompson, subsetConstruction, minimize, nfaRun, dfaRun, fmtRanges, epsilonClosure, nfaMove, RegexSyntaxError } from '@compy/lab';
import { Automaton } from './Automaton';
import { Stepper } from './Stepper';
import { GNode, GEdge } from './graph';

/**
 * The automata panel: for one lexical rule (or the whole scanner) show the
 * Thompson NFA, the subset construction with its table, Hopcroft's rounds
 * and the minimal DFA, and a membership tester that animates both machines
 * over a string.
 */
interface Props {
  lexer: CompiledLexer | null;
  lexerMode: 'rules' | 'chars' | 'given';
}

export function nfaGraph(nfa: Nfa, ruleNames?: string[]): { nodes: GNode[]; edges: GEdge[] } {
  const nodes: GNode[] = Array.from({ length: nfa.states }, (_, id) => ({ id, label: `${id}`, accept: nfa.accept.has(id), start: id === nfa.start, sub: nfa.accept.has(id) && ruleNames ? ruleNames[nfa.accept.get(id)!] : undefined }));
  const edges: GEdge[] = nfa.edges.map((e) => ({ from: e.from, to: e.to, label: e.label }));
  return { nodes, edges };
}
export function dfaGraph(dfa: Dfa, ruleNames?: string[], showSubsets = true): { nodes: GNode[]; edges: GEdge[] } {
  const nodes: GNode[] = Array.from({ length: dfa.states }, (_, id) => ({
    id,
    label: `S${id}`,
    accept: dfa.accept.has(id),
    start: id === dfa.start,
    sub: dfa.accept.has(id) && ruleNames ? ruleNames[dfa.accept.get(id)!] : showSubsets && dfa.subsets[id] ? `{${dfa.subsets[id]!.join(',')}}` : undefined,
  }));
  const edges: GEdge[] = dfa.edges.map((e) => ({ from: e.from, to: e.to, label: e.label }));
  return { nodes, edges };
}

export function AutomataView({ lexer, lexerMode }: Props) {
  const [stateName, setStateName] = useState('INITIAL');
  const [ruleIdx, setRuleIdx] = useState<number | 'all'>('all');
  const [view, setView] = useState<'nfa' | 'subset' | 'dfa' | 'min' | 'test'>('nfa');
  const [custom, setCustom] = useState('');
  const [probe, setProbe] = useState('');
  const cs: CompiledState | null = lexer?.states.find((s) => s.state === stateName) ?? lexer?.states[0] ?? null;

  const built = useMemo(() => {
    try {
      if (custom.trim()) {
        const re = parseRegex(custom.trim());
        const nfa = thompson(re);
        const dfa = subsetConstruction(nfa);
        const min = minimize(dfa);
        return { title: `/${custom.trim()}/`, nfa, dfa, min, names: ['match'], error: null as string | null };
      }
      if (!cs) return null;
      if (ruleIdx === 'all') {
        const min = minimize(cs.dfa);
        return { title: `scanner DFA for start condition ${cs.state}`, nfa: cs.combined, dfa: cs.dfa, min, names: cs.rules.map((r) => r.name), error: null as string | null };
      }
      const rule = cs.rules[ruleIdx];
      if (!rule || !rule.re) return null;
      const nfa = thompson(rule.re);
      const dfa = subsetConstruction(nfa);
      const min = minimize(dfa);
      return { title: `${rule.name}: /${rule.pattern}/`, nfa, dfa, min, names: [rule.name], error: null as string | null };
    } catch (e) {
      return { title: '', nfa: null, dfa: null, min: null, names: [], error: e instanceof RegexSyntaxError ? `${e.message} at ${e.at}` : String(e) };
    }
  }, [cs, ruleIdx, custom]);

  if (lexerMode !== 'rules' && !custom.trim()) {
    return (
      <div className="automata">
        <p className="hint">The {lexerMode === 'chars' ? 'character lexer' : 'given-tokens mode'} has no automaton. Try a regular expression here:</p>
        <RegexBox custom={custom} setCustom={setCustom} />
      </div>
    );
  }

  return (
    <div className="automata" data-testid="automata">
      <div className="panel-toolbar">
        {lexer && lexer.states.length > 1 && (
          <select value={stateName} onChange={(e) => setStateName(e.target.value)}>
            {lexer.states.map((s) => (
              <option key={s.state} value={s.state}>
                condition {s.state}
              </option>
            ))}
          </select>
        )}
        {cs && (
          <select value={String(ruleIdx)} onChange={(e) => { setRuleIdx(e.target.value === 'all' ? 'all' : Number(e.target.value)); setCustom(''); }} data-testid="rule-select">
            <option value="all">whole scanner ({cs.rules.length} rules)</option>
            {cs.rules.map((r, k) => (
              <option key={k} value={k}>
                {r.name}: /{r.pattern}/
              </option>
            ))}
          </select>
        )}
        <span className="seg-toggle">
          <button className={view === 'nfa' ? 'active' : ''} onClick={() => setView('nfa')}>Thompson NFA</button>
          <button className={view === 'subset' ? 'active' : ''} onClick={() => setView('subset')}>subset construction</button>
          <button className={view === 'dfa' ? 'active' : ''} onClick={() => setView('dfa')}>DFA</button>
          <button className={view === 'min' ? 'active' : ''} onClick={() => setView('min')}>minimal DFA</button>
          <button className={view === 'test' ? 'active' : ''} onClick={() => setView('test')}>run a string</button>
        </span>
      </div>
      <RegexBox custom={custom} setCustom={setCustom} />
      {built?.error && <div className="fault-banner">regex error: {built.error}</div>}
      {built && built.nfa && built.dfa && built.min && (
        <>
          <div className="aut-title">{built.title}</div>
          {view === 'nfa' && (
            <>
              <p className="hint">Thompson's construction: one fragment per regex operator, glued with ε-edges. {built.nfa.states} states, {built.nfa.edges.length} edges.</p>
              <Automaton {...nfaGraph(built.nfa, built.names)} start={built.nfa.start} compact={built.nfa.states > 24} testId="nfa" />
            </>
          )}
          {view === 'subset' && <SubsetTable nfa={built.nfa} dfa={built.dfa} />}
          {view === 'dfa' && (
            <>
              <p className="hint">Each DFA state is a set of NFA states (shown under it). {built.dfa.states} states; the alphabet was split into {built.dfa.alphabet.length} disjoint ranges.</p>
              <Automaton {...dfaGraph(built.dfa, built.names.length > 1 ? built.names : undefined)} start={built.dfa.start} compact={built.dfa.states > 12} testId="dfa" />
            </>
          )}
          {view === 'min' && <MinView dfa={built.dfa} min={built.min} names={built.names} />}
          {view === 'test' && <Tester nfa={built.nfa} dfa={built.min.dfa} names={built.names} probe={probe} setProbe={setProbe} />}
        </>
      )}
    </div>
  );
}

function RegexBox({ custom, setCustom }: { custom: string; setCustom: (s: string) => void }) {
  return (
    <div className="regex-box">
      <label>
        or any regex: <input className="mono" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="(a|b)*abb" data-testid="regex-input" />
      </label>
      {custom && (
        <button className="link" onClick={() => setCustom('')}>
          back to the rules
        </button>
      )}
    </div>
  );
}

function SubsetTable({ nfa, dfa }: { nfa: Nfa; dfa: Dfa }) {
  const rows = dfa.subsets.map((subset, id) => {
    const set = new Set(subset);
    const cells = dfa.alphabet.map(([lo, hi]) => {
      const moved = nfaMove(nfa, set, lo);
      const closure = epsilonClosure(nfa, moved);
      const target = dfa.edges.find((e) => e.from === id && e.set.ranges.some(([a, b]) => lo >= a && hi <= b));
      return { label: fmtRanges([[lo, hi]]), moved: [...moved].sort((a, b) => a - b), closure: [...closure].sort((a, b) => a - b), target: target?.to ?? null };
    });
    return { id, subset, cells };
  });
  return (
    <div className="subset">
      <p className="hint">
        Subset construction: start from ε-closure({nfa.start}) = {'{'}{dfa.subsets[0]?.join(',')}{'}'}; for each DFA state and input range, take the NFA states reachable on that input, then their ε-closure. A new set is a new DFA state.
      </p>
      <table className="mem-table subset-table">
        <thead>
          <tr>
            <th>DFA state</th>
            <th>NFA states</th>
            {dfa.alphabet.map(([lo, hi], k) => (
              <th key={k} className="mono">
                {fmtRanges([[lo, hi]])}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">S{r.id}{dfa.accept.has(r.id) ? ' ✓' : ''}</td>
              <td className="mono dim">{'{'}{r.subset.join(',')}{'}'}</td>
              {r.cells.map((c, k) => (
                <td key={k} className="mono" title={c.moved.length ? `move = {${c.moved.join(',')}}, ε-closure = {${c.closure.join(',')}}` : 'no transition'}>
                  {c.target === null ? '∅' : `S${c.target}`}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MinView({ dfa, min, names }: { dfa: Dfa; min: ReturnType<typeof minimize>; names: string[] }) {
  return (
    <div>
      <p className="hint">
        Hopcroft's algorithm: start with two groups (accepting / not), then split any group whose members go to different groups on some input, until stable. {dfa.states} → {min.dfa.states} states.
      </p>
      <div className="rounds">
        {min.rounds.map((round, k) => (
          <div key={k} className="round">
            <span className="dim">round {k}:</span>{' '}
            {round.map((g, j) => (
              <span key={j} className="group mono">
                {'{'}{g.map((s) => 'S' + s).join(' ')}{'}'}
              </span>
            ))}
          </div>
        ))}
      </div>
      <Automaton {...dfaGraph(min.dfa, names.length > 1 ? names : undefined, false)} start={min.dfa.start} compact={min.dfa.states > 12} testId="min-dfa" />
      <p className="hint">Merged: {min.rounds[min.rounds.length - 1]?.filter((g) => g.length > 1).map((g) => '{' + g.map((s) => 'S' + s).join(' ') + '}').join(', ') || 'nothing (the DFA was already minimal)'}.</p>
    </div>
  );
}

function Tester({ nfa, dfa, names, probe, setProbe }: { nfa: Nfa; dfa: Dfa; names: string[]; probe: string; setProbe: (s: string) => void }) {
  const [pos, setPos] = useState(0);
  const [machine, setMachine] = useState<'nfa' | 'dfa'>('dfa');
  const run = useMemo(() => ({ n: nfaRun(nfa, probe), d: dfaRun(dfa, probe) }), [nfa, dfa, probe]);
  const steps = probe.length + 1;
  const p = Math.min(pos, steps - 1);
  const activeN = run.n.sets[p] ?? new Set<number>();
  const activeD = run.d.path[p];
  const dead = activeD === null || activeD === undefined;
  return (
    <div className="tester" data-testid="tester">
      <div className="panel-toolbar">
        <label>
          string: <input className="mono" value={probe} onChange={(e) => { setProbe(e.target.value); setPos(0); }} placeholder="type a string to test" data-testid="probe" />
        </label>
        <span className="seg-toggle">
          <button className={machine === 'dfa' ? 'active' : ''} onClick={() => setMachine('dfa')}>DFA</button>
          <button className={machine === 'nfa' ? 'active' : ''} onClick={() => setMachine('nfa')}>NFA</button>
        </span>
        <span className={`verdict ${run.d.accepted ? 'yes' : 'no'}`} data-testid="verdict">
          {probe === '' && p === 0 ? '' : run.d.accepted ? `accepted${names.length > 1 ? ` as ${names[run.d.ruleId ?? 0]}` : ''}` : 'rejected'}
        </span>
      </div>
      <div className="tape">
        {[...probe].map((ch, k) => (
          <span key={k} className={`cell ${k < p ? 'done' : k === p ? 'cur' : ''}`}>
            {ch === ' ' ? '␣' : ch}
          </span>
        ))}
        <span className={`cell end ${p === probe.length ? 'cur' : ''}`}>⊣</span>
      </div>
      <Stepper pos={p} count={steps} onChange={setPos} label="char" testId="tester-stepper" />
      {machine === 'dfa' ? (
        <>
          <p className="hint">{dead ? 'no transition: the DFA is dead, the string is rejected' : `in state S${activeD}${dfa.accept.has(activeD) ? ' (accepting)' : ''}`}</p>
          <Automaton {...dfaGraph(dfa, names.length > 1 ? names : undefined, false)} start={dfa.start} active={dead ? new Set() : new Set([activeD])} trail={new Set(run.d.path.slice(0, p).filter((x): x is number => x !== null))} compact={dfa.states > 12} />
        </>
      ) : (
        <>
          <p className="hint">active NFA states: {'{'}{[...activeN].sort((a, b) => a - b).join(', ')}{'}'} — the NFA is in all of them at once (this set is exactly one DFA state).</p>
          <Automaton {...nfaGraph(nfa, names)} start={nfa.start} active={activeN} compact={nfa.states > 24} />
        </>
      )}
    </div>
  );
}
