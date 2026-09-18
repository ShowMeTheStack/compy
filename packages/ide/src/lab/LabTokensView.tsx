import { useEffect, useState } from 'react';
import { LabResult } from '@compy/lab';
import { Automaton } from './Automaton';
import { Stepper } from './Stepper';
import { dfaGraph } from './AutomataView';
import { EditorRange } from '../Editor';

/**
 * Tokens panel of the lab: the token stream, and a scanner stepper that
 * replays maximal munch on the input tape with the scanner DFA animated.
 */
interface Props {
  result: LabResult;
  input: string;
  onHover: (r: EditorRange | null) => void;
}

export function LabTokensView({ result, input, onHover }: Props) {
  const [pos, setPos] = useState(0);
  const steps = result.lex.steps;
  useEffect(() => setPos(0), [steps]);
  const step = steps[Math.min(pos, Math.max(0, steps.length - 1))];
  const cs = result.lexer?.states.find((s) => s.state === step?.state);
  const rangeOf = (start: number, end: number): EditorRange => {
    const lc = (p: number) => {
      const before = input.slice(0, p);
      const line = before.split('\n').length;
      const col = p - (before.lastIndexOf('\n') + 1) + 1;
      return { line, col };
    };
    const a = lc(start);
    const b = lc(Math.max(start, end - 1));
    return { line: a.line, col: a.col, endLine: b.line, endCol: b.col };
  };
  const tokenStart = step?.token?.start ?? (step?.lastAccept ? step.lastAccept.pos : step?.pos ?? 0);
  return (
    <div className="lab-tokens" data-testid="lab-tokens">
      <h3>Token stream ({result.tokens.length})</h3>
      <div className="token-stream" onMouseLeave={() => onHover(null)}>
        {result.tokens.map((t, k) => (
          <span key={k} className={`tok ${t.rule?.generated ? 'tok-keyword' : 'tok-identifier'}`} title={`${t.name} @ ${t.line}:${t.col}${t.rule ? ` by rule ${t.rule.name} (line ${t.rule.line})` : ''}`} onMouseEnter={() => onHover(rangeOf(t.start, t.end))}>
            <span className="tok-name">{t.name}</span>
            {t.text !== t.name && <span className="tok-text">{t.text.replace(/\n/g, '\\n')}</span>}
          </span>
        ))}
        {result.tokens.length === 0 && <span className="dim">no tokens yet</span>}
      </div>
      {result.lex.errors.length > 0 && <div className="fault-banner">{result.lex.errors.map((e) => e.message).join('; ')}</div>}

      {steps.length > 0 && (
        <>
          <h3>Scanner stepper</h3>
          <div className="tape small">
            {[...input].slice(0, 400).map((ch, k) => {
              const inToken = step?.token && k >= step.token.start && k < step.token.end;
              const cls = step && k === step.pos ? 'cur' : inToken ? 'done' : step && k >= tokenStart && k < step.pos ? 'scan' : '';
              return (
                <span key={k} className={`cell ${cls}`} onMouseEnter={() => onHover(rangeOf(k, k + 1))}>
                  {ch === '\n' ? '↵' : ch === ' ' ? '␣' : ch}
                </span>
              );
            })}
          </div>
          <Stepper pos={Math.min(pos, steps.length - 1)} count={steps.length} onChange={setPos} testId="lex-stepper" />
          {step && (
            <div className={`step-detail action-${step.action}`} data-testid="lex-step">
              <span className="action-badge">{step.action}</span> {step.detail}
              {step.lastAccept && step.action === 'advance' && <span className="dim"> · last accept: {step.lastAccept.rule} at {step.lastAccept.pos}</span>}
            </div>
          )}
          {cs && (
            <Automaton {...dfaGraph(cs.minimal, cs.rules.map((r) => r.name), false)} start={cs.minimal.start} active={new Set(step?.dfaState !== null && step?.dfaState !== undefined ? [step.dfaState] : [])} activeEdge={step?.action === 'advance' && step.dfaState !== null && step.nextDfaState !== null && step.nextDfaState !== undefined ? [step.dfaState, step.nextDfaState] : null} compact={cs.minimal.states > 12} />
          )}
          <p className="hint">Maximal munch: keep going while a transition exists, remember the last accepting position, and when stuck back up to it. Earlier rules win ties.</p>
        </>
      )}
    </div>
  );
}
