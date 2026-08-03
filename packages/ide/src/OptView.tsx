import { useMemo, useState } from 'react';
import { PASSES, PassId, OptimizeResult, PassRecord, instrCount, Module } from '@compy/ir';

/**
 * Optimizer panel: toggle passes, read what each one does, and inspect a
 * before/after diff of every function a pass changed.
 */
interface Props {
  ir: Module | null;
  opt: OptimizeResult | null;
  passes: PassId[];
  onPassesChange: (p: PassId[]) => void;
}

export function OptView({ ir, opt, passes, onPassesChange }: Props) {
  const [sel, setSel] = useState<number | null>(null);
  const [showDesc, setShowDesc] = useState<PassId | null>(null);
  const totals = useMemo(() => {
    if (!ir || !opt) return null;
    const before = ir.functions.reduce((n, f) => n + instrCount(f), 0);
    const after = opt.module.functions.reduce((n, f) => n + instrCount(f), 0);
    return { before, after };
  }, [ir, opt]);
  const toggle = (id: PassId) => onPassesChange(passes.includes(id) ? passes.filter((p) => p !== id) : [...passes, id]);
  const record = sel !== null ? opt?.records[sel] ?? null : null;

  return (
    <div className="optview" data-testid="optimize">
      <section>
        <h3>Passes</h3>
        <div className="pass-list">
          {PASSES.map((p) => {
            const hits = opt?.records.filter((r) => r.pass === p.id).length ?? 0;
            return (
              <div key={p.id} className={`pass ${passes.includes(p.id) ? 'on' : ''}`}>
                <label>
                  <input type="checkbox" checked={passes.includes(p.id)} onChange={() => toggle(p.id)} data-testid={`pass-${p.id}`} /> {p.name}
                </label>
                <span className="pass-hits">{hits ? `${hits} change${hits > 1 ? 's' : ''}` : ''}</span>
                <button className="link" onClick={() => setShowDesc(showDesc === p.id ? null : p.id)}>
                  {showDesc === p.id ? 'less' : 'what is this?'}
                </button>
                {showDesc === p.id && <p className="pass-desc">{p.description}</p>}
              </div>
            );
          })}
        </div>
        <div className="panel-toolbar">
          <button className="btn" onClick={() => onPassesChange(PASSES.map((p) => p.id))}>all on</button>
          <button className="btn" onClick={() => onPassesChange([])}>all off</button>
          {totals && (
            <span className="opt-totals">
              {totals.before} → <b>{totals.after}</b> instructions ({totals.before ? Math.round((1 - totals.after / totals.before) * 100) : 0}% fewer), {opt?.rounds ?? 0} round(s)
            </span>
          )}
        </div>
      </section>

      <section>
        <h3>What happened</h3>
        {!opt || opt.records.length === 0 ? (
          <p className="hint">{opt ? 'No pass changed anything. Try enabling more passes, or write code with something to optimize (a loop with an invariant, `x * 8`, an unused variable…).' : 'Compile cleanly to run the optimizer.'}</p>
        ) : (
          <ol className="pass-log">
            {opt.records.map((r, k) => (
              <li key={k} className={sel === k ? 'active' : ''} onClick={() => setSel(sel === k ? null : k)}>
                <span className="pass-name">{PASSES.find((p) => p.id === r.pass)?.name ?? r.pass}</span> on <code>@{r.fn}</code>
                <span className="pass-delta">
                  {r.instrsBefore} → {r.instrsAfter}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {record && (
        <section>
          <h3>
            {PASSES.find((p) => p.id === record.pass)?.name} — @{record.fn}
          </h3>
          <Diff before={record.before} after={record.after} />
        </section>
      )}
      <p className="hint">Click an entry to see exactly what the pass rewrote. Removed lines are red, added lines green.</p>
    </div>
  );
}

/** A small LCS-based line diff. */
export function diffLines(a: string[], b: string[]): { kind: ' ' | '-' | '+'; text: string }[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { kind: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: '-', text: a[i++]! });
    else out.push({ kind: '+', text: b[j++]! });
  }
  while (i < n) out.push({ kind: '-', text: a[i++]! });
  while (j < m) out.push({ kind: '+', text: b[j++]! });
  return out;
}

export function Diff({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => diffLines(before.split('\n'), after.split('\n')), [before, after]);
  return (
    <pre className="diff" data-testid="diff">
      {rows.map((r, k) => (
        <div key={k} className={`diff-row ${r.kind === '-' ? 'del' : r.kind === '+' ? 'add' : ''}`}>
          <span className="diff-sign">{r.kind}</span>
          {r.text}
        </div>
      ))}
    </pre>
  );
}

export type { PassRecord };
