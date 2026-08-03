import { useEffect, useMemo, useState } from 'react';
import { CodegenResult, AllocStrategy, INT_REGS, FLOAT_REGS, IntervalInfo } from '@compy/codegen';
import { EditorRange } from './Editor';
import { MachTraceEntry } from './session';

/**
 * Code generation panel: the RISC-V listing (before and after register
 * allocation), the allocator's live intervals, and a machine-level stepper
 * that replays the simulator's trace with the register file.
 */
interface Props {
  cg: CodegenResult | null;
  cgError: string | null;
  strategy: AllocStrategy;
  onStrategyChange: (s: AllocStrategy) => void;
  onHover: (r: EditorRange | null) => void;
  trace: MachTraceEntry[];
  traceActive: boolean;
  onRequestTrace: () => void;
}

export function AsmView({ cg, cgError, strategy, onStrategyChange, onHover, trace, traceActive, onRequestTrace }: Props) {
  const [view, setView] = useState<'asm' | 'vregs' | 'regalloc' | 'step'>('asm');
  if (cgError) return <p className="hint">Code generation failed: {cgError}</p>;
  if (!cg) return <p className="hint">Assembly appears once the program compiles without errors.</p>;
  const stats = cg.reports.reduce((a, r) => ({ spilled: a.spilled + r.spilled, frame: a.frame + r.frameSize }), { spilled: 0, frame: 0 });
  return (
    <div className="asmview" data-testid="asm">
      <div className="panel-toolbar">
        <label>
          allocator{' '}
          <select value={strategy} onChange={(e) => onStrategyChange(e.target.value as AllocStrategy)} data-testid="allocator">
            <option value="linear-scan">linear scan</option>
            <option value="naive">naive (spill everything)</option>
          </select>
        </label>
        <span className="seg-toggle">
          <button className={view === 'asm' ? 'active' : ''} onClick={() => setView('asm')}>listing</button>
          <button className={view === 'vregs' ? 'active' : ''} onClick={() => setView('vregs')}>before regalloc</button>
          <button className={view === 'regalloc' ? 'active' : ''} onClick={() => setView('regalloc')}>live intervals</button>
          <button className={view === 'step' ? 'active' : ''} onClick={() => setView('step')}>step</button>
        </span>
        <span className="spacer" />
        <span className="dim">{stats.spilled} spilled · frames {stats.frame} B</span>
      </div>
      {view === 'asm' && <Listing text={cg.asm} onHover={onHover} />}
      {view === 'vregs' && (
        <>
          <p className="hint">Instruction selection output: each IR register became a virtual register (v12, fv3). The allocator maps these onto the 31 real registers.</p>
          <pre className="asm-text">{cg.preRA}</pre>
        </>
      )}
      {view === 'regalloc' && <Intervals cg={cg} />}
      {view === 'step' && <MachStepper trace={trace} active={traceActive} onRequestTrace={onRequestTrace} onHover={onHover} />}
      <p className="hint">RV32IM + F/D. Arguments travel in a0–a7 / fa0–fa7, the result in a0; s-registers survive calls, t-registers do not.</p>
    </div>
  );
}

function Listing({ text, onHover }: { text: string; onHover: (r: EditorRange | null) => void }) {
  const lines = useMemo(() => text.split('\n'), [text]);
  let curLine: number | null = null;
  return (
    <pre className="asm-text" onMouseLeave={() => onHover(null)} data-testid="asm-listing">
      {lines.map((l, k) => {
        const m = /^\s*# line (\d+):/.exec(l);
        if (m) curLine = Number(m[1]);
        const line = curLine;
        const cls = m ? 'asm-src' : /^\S.*:$/.test(l) ? 'asm-label' : /^\s*\./.test(l) ? 'asm-dir' : l.trim().startsWith('#') ? 'asm-comment' : 'asm-instr';
        return (
          <div key={k} className={`asm-row ${cls}`} onMouseEnter={() => line && cls === 'asm-instr' && onHover({ line, col: 1, endLine: line, endCol: 0 })}>
            {l}
          </div>
        );
      })}
    </pre>
  );
}

function Intervals({ cg }: { cg: CodegenResult }) {
  const [fnIdx, setFnIdx] = useState(0);
  const r = cg.reports[fnIdx] ?? cg.reports[0];
  if (!r) return null;
  const max = Math.max(1, ...r.intervals.map((i) => i.end));
  const color = (iv: IntervalInfo) => (iv.assigned === 'stack' ? '#e51400' : iv.assigned.startsWith('s') || iv.assigned.startsWith('fs') ? '#3867d6' : '#20bf6b');
  return (
    <div className="intervals">
      <div className="panel-toolbar">
        <select value={fnIdx} onChange={(e) => setFnIdx(Number(e.target.value))}>
          {cg.mmod.functions.map((f, k) => (
            <option key={f.name} value={k}>
              {f.name}
            </option>
          ))}
        </select>
        <span className="dim">
          {r.strategy} · {r.intervals.length} virtual registers · {r.spilled} spilled · callee-saved used: {r.calleeSaved.join(' ') || 'none'} · frame {r.frameSize} B
        </span>
      </div>
      <p className="hint">
        Each bar is a virtual register's live interval over the instruction numbering. <span className="edge-key true">caller-saved</span> <span className="edge-key cs">callee-saved (crosses a call)</span> <span className="edge-key spill">spilled to the stack</span>
      </p>
      <div className="interval-chart">
        {r.intervals.map((iv) => (
          <div key={iv.vreg} className="interval-row" title={`${iv.vreg}: [${iv.start}, ${iv.end}] → ${iv.assigned}${iv.crossesCall ? ' (live across a call)' : ''}`}>
            <span className="interval-name mono">{iv.vreg}</span>
            <div className="interval-track">
              <div className="interval-bar" style={{ left: `${(iv.start / max) * 100}%`, width: `${Math.max(1, ((iv.end - iv.start + 1) / max) * 100)}%`, background: color(iv) }} />
            </div>
            <span className="interval-reg mono">{iv.assigned}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MachStepper({ trace, active, onRequestTrace, onHover }: { trace: MachTraceEntry[]; active: boolean; onRequestTrace: () => void; onHover: (r: EditorRange | null) => void }) {
  const [pos, setPos] = useState(0);
  useEffect(() => setPos(0), [trace]);
  if (!active || trace.length === 0) {
    return (
      <div className="stepper-empty">
        <p className="hint">Run the program on the <b>RISC-V simulator</b> with tracing to step through the machine code and watch the registers.</p>
        <button className="btn" onClick={onRequestTrace} data-testid="mach-trace">
          ▶ Trace on the machine
        </button>
      </div>
    );
  }
  const cur = trace[Math.min(pos, trace.length - 1)]!;
  // Each trace entry holds the registers *before* its instruction ran, so the
  // state after the current instruction is the next entry's snapshot.
  const after = trace[Math.min(pos + 1, trace.length - 1)]!;
  const prev = cur;
  const base = Math.max(0, pos - 6);
  const window = trace.slice(base, pos + 8);
  return (
    <div className="stepper" data-testid="mach-stepper">
      <div className="stepper-controls">
        <button className="btn" onClick={() => setPos(0)} title="first">⏮</button>
        <button className="btn" onClick={() => setPos((p) => Math.max(0, p - 1))} title="back">←</button>
        <button className="btn" onClick={() => setPos((p) => Math.min(trace.length - 1, p + 1))} title="next" data-testid="mach-next">→</button>
        <button className="btn" onClick={() => setPos(trace.length - 1)} title="last">⏭</button>
        <span className="step-count">
          instr {pos + 1}/{trace.length} · pc 0x{cur.pc.toString(16)} · {cur.fn}
        </span>
      </div>
      <pre className="trace-window">
        {window.map((e, k) => (
          <div key={k} className={`trace-row ${base + k === pos ? 'current' : ''}`} onMouseEnter={() => onHover(e.line ? { line: e.line, col: 1, endLine: e.line, endCol: 0 } : null)} onClick={() => setPos(base + k)}>
            <span className="dim">{e.pc.toString(16)}</span> {e.text}
          </div>
        ))}
      </pre>
      <h3>Integer registers (after this instruction)</h3>
      <div className="reg-grid">
        {INT_REGS.map((name, k) => {
          const v = after.x[k]!;
          const changed = after !== prev ? prev.x[k] !== v : v !== 0;
          return (
            <span key={name} className={`reg ${changed ? 'changed' : ''} ${v === 0 ? 'zero' : ''}`} title={`x${k}`}>
              {name} = <b>{name === 'sp' || name === 's0' || name === 'ra' ? '0x' + (v >>> 0).toString(16) : v}</b>
            </span>
          );
        })}
      </div>
      <h3>Floating registers</h3>
      <div className="reg-grid">
        {FLOAT_REGS.map((name, k) => {
          const v = after.f[k]!;
          if (v === 0 && prev.f[k] === 0) return null;
          return (
            <span key={name} className={`reg ${prev.f[k] !== v ? 'changed' : ''}`}>
              {name} = <b>{v}</b>
            </span>
          );
        })}
      </div>
      <p className="hint">The register that just changed is highlighted. Before a call, watch arguments land in a0–a7; after it, the result in a0.</p>
    </div>
  );
}
