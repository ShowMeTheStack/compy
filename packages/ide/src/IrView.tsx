import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Module, Func, fmtInstr, fmtValue, successors, terminatorOf, isTerminator } from '@compy/ir';
import { EditorRange } from './Editor';
import { IrTraceEntry } from './session';

/**
 * IR panel: the lowered program as text or as a control-flow graph, with
 * every instruction linked to the source line it came from, plus a stepper
 * that replays the IR interpreter's trace and shows the registers.
 */
interface Props {
  ir: Module | null;
  optimized: Module | null;
  onHover: (r: EditorRange | null) => void;
  trace: IrTraceEntry[];
  traceEngine: boolean;
  onRequestTrace: () => void;
}

export function IrView({ ir, optimized, onHover, trace, traceEngine, onRequestTrace }: Props) {
  const [which, setWhich] = useState<'lowered' | 'optimized'>('lowered');
  const [view, setView] = useState<'text' | 'cfg' | 'step'>('text');
  const mod = which === 'optimized' ? optimized : ir;
  const [fnName, setFnName] = useState<string>('');
  const fns = mod?.functions ?? [];
  const fn = fns.find((f) => f.name === fnName) ?? fns.find((f) => f.name === 'main') ?? fns[0] ?? null;
  if (!mod) return <p className="hint">The IR appears once the program compiles without errors.</p>;

  return (
    <div className="irview" data-testid="ir">
      <div className="panel-toolbar">
        <select value={which} onChange={(e) => setWhich(e.target.value as 'lowered' | 'optimized')}>
          <option value="lowered">as lowered (−O0)</option>
          <option value="optimized">after optimization</option>
        </select>
        <select value={fn?.name ?? ''} onChange={(e) => setFnName(e.target.value)}>
          {fns.map((f) => (
            <option key={f.name} value={f.name}>
              @{f.name}
            </option>
          ))}
        </select>
        <span className="seg-toggle">
          <button className={view === 'text' ? 'active' : ''} onClick={() => setView('text')}>text</button>
          <button className={view === 'cfg' ? 'active' : ''} onClick={() => setView('cfg')}>CFG</button>
          <button className={view === 'step' ? 'active' : ''} onClick={() => setView('step')}>step</button>
        </span>
      </div>
      {view === 'text' && fn && <IrText mod={mod} fn={fn} onHover={onHover} />}
      {view === 'cfg' && fn && <Cfg fn={fn} onHover={onHover} />}
      {view === 'step' && <IrStepper trace={trace} active={traceEngine} onRequestTrace={onRequestTrace} onHover={onHover} />}
      <p className="hint">
        Each instruction defines one register exactly once (SSA). Locals start as <code>alloca</code> stack slots; after mem2reg they become registers and <code>phi</code> nodes merge values where paths join.
      </p>
    </div>
  );
}

function IrText({ mod, fn, onHover }: { mod: Module; fn: Func; onHover: (r: EditorRange | null) => void }) {
  const header = useMemo(() => {
    const lines: string[] = [];
    mod.strings.forEach((s, k) => lines.push(`@.str${k} = "${bytesToText(s)}"`));
    for (const g of mod.globals) lines.push(`@${g.name} = ${g.internal ? 'internal ' : ''}${g.readonly ? 'constant' : 'global'} ${g.ctype}`);
    if (mod.externs.length) lines.push(`declare ${mod.externs.map((e) => '@' + e).join(', ')}`);
    return lines;
  }, [mod]);
  return (
    <pre className="ir-text" onMouseLeave={() => onHover(null)}>
      {header.map((l, k) => (
        <div key={'h' + k} className="ir-global">{l}</div>
      ))}
      <div className="ir-def">
        define {fn.ret} @{fn.name}({fn.params.map((p) => `${p.type} ${fmtValue(p)}`).join(', ')}{fn.variadic ? ', ...' : ''}) {'{'}
      </div>
      {fn.blocks.map((b) => (
        <div key={b.name}>
          <div className="ir-label">{b.name}:</div>
          {b.instrs.map((i, k) => (
            <div key={k} className={`ir-instr ${isTerminator(i) ? 'term' : ''} ${i.op === 'phi' ? 'phi' : ''}`} onMouseEnter={() => onHover(i.line ? { line: i.line, col: 1, endLine: i.line, endCol: 0 } : null)} title={i.line ? `from line ${i.line}` : ''}>
              {'  '}{fmtInstr(i)}
              {i.line !== undefined && <span className="ir-line">;{i.line}</span>}
            </div>
          ))}
        </div>
      ))}
      <div className="ir-def">{'}'}</div>
    </pre>
  );
}

function bytesToText(b: Uint8Array): string {
  let s = '';
  for (let k = 0; k < b.length - 1; k++) {
    const c = b[k]!;
    s += c === 10 ? '\\n' : c === 9 ? '\\t' : c === 34 ? '\\"' : c >= 32 && c < 127 ? String.fromCharCode(c) : '\\x' + c.toString(16).padStart(2, '0');
  }
  return s;
}

/** A control-flow graph drawn as block cards with SVG edges. */
function Cfg({ fn, onHover }: { fn: Func; onHover: (r: EditorRange | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const [edges, setEdges] = useState<{ from: string; to: string; d: string; back: boolean; kind: string }[]>([]);
  const order = useMemo(() => fn.blocks.map((b) => b.name), [fn]);

  const layout = () => {
    const hostEl = host.current;
    if (!hostEl) return;
    const hb = hostEl.getBoundingClientRect();
    const out: typeof edges = [];
    for (const b of fn.blocks) {
      const t = terminatorOf(b);
      if (!t) continue;
      const succ = successors(t);
      succ.forEach((s, k) => {
        const fe = refs.current.get(b.name);
        const te = refs.current.get(s);
        if (!fe || !te) return;
        const fr = fe.getBoundingClientRect();
        const tr = te.getBoundingClientRect();
        const back = order.indexOf(s) <= order.indexOf(b.name);
        const x1 = fr.left - hb.left + fr.width / 2 + (succ.length > 1 ? (k === 0 ? -40 : 40) : 0);
        const y1 = fr.bottom - hb.top;
        const x2 = tr.left - hb.left + tr.width / 2 + (back ? 60 : 0);
        const y2 = tr.top - hb.top;
        let d: string;
        if (back) {
          const xr = Math.max(fr.right, tr.right) - hb.left + 24;
          d = `M ${fr.right - hb.left} ${y1 - fr.height / 2} C ${xr} ${y1 - fr.height / 2}, ${xr} ${y2 + tr.height / 2}, ${tr.right - hb.left} ${y2 + tr.height / 2}`;
        } else d = `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
        const kind = t.op === 'condbr' ? (k === 0 ? 'true' : 'false') : t.op === 'switch' ? (k === 0 ? 'default' : 'case') : '';
        out.push({ from: b.name, to: s, d, back, kind });
      });
    }
    setEdges(out);
  };
  useLayoutEffect(layout, [fn]);
  useEffect(() => {
    const ro = new ResizeObserver(layout);
    if (host.current) ro.observe(host.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn]);

  return (
    <div className="cfg" ref={host} onMouseLeave={() => onHover(null)}>
      <svg className="cfg-edges">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#8fd3c4" />
          </marker>
          <marker id="arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#e9a23b" />
          </marker>
        </defs>
        {edges.map((e, k) => (
          <path key={k} d={e.d} className={`cfg-edge ${e.back ? 'back' : ''} ${e.kind}`} markerEnd={e.back ? 'url(#arrow-back)' : 'url(#arrow)'} />
        ))}
      </svg>
      {fn.blocks.map((b) => (
        <div
          key={b.name}
          className="cfg-block"
          ref={(el) => {
            if (el) refs.current.set(b.name, el);
          }}
        >
          <div className="cfg-title">{b.name}</div>
          {b.instrs.map((i, k) => (
            <div key={k} className={`cfg-instr ${isTerminator(i) ? 'term' : ''}`} onMouseEnter={() => onHover(i.line ? { line: i.line, col: 1, endLine: i.line, endCol: 0 } : null)}>
              {fmtInstr(i)}
            </div>
          ))}
        </div>
      ))}
      <p className="hint cfg-legend">
        <span className="edge-key true">true</span> <span className="edge-key false">false</span> <span className="edge-key back">back edge (loop)</span>
      </p>
    </div>
  );
}

function IrStepper({ trace, active, onRequestTrace, onHover }: { trace: IrTraceEntry[]; active: boolean; onRequestTrace: () => void; onHover: (r: EditorRange | null) => void }) {
  const [pos, setPos] = useState(0);
  useEffect(() => setPos(0), [trace]);
  if (!active || trace.length === 0) {
    return (
      <div className="stepper-empty">
        <p className="hint">Run the program on the <b>IR interpreter</b> with tracing to step through it instruction by instruction.</p>
        <button className="btn" onClick={onRequestTrace} data-testid="ir-trace">
          ▶ Trace on the IR engine
        </button>
      </div>
    );
  }
  const cur = trace[Math.min(pos, trace.length - 1)]!;
  const after = trace[Math.min(pos + 1, trace.length - 1)]!;
  const window = trace.slice(Math.max(0, pos - 6), pos + 8);
  const base = Math.max(0, pos - 6);
  return (
    <div className="stepper" data-testid="ir-stepper">
      <div className="stepper-controls">
        <button className="btn" onClick={() => setPos(0)} title="first">⏮</button>
        <button className="btn" onClick={() => setPos((p) => Math.max(0, p - 1))} title="back">←</button>
        <button className="btn" onClick={() => setPos((p) => Math.min(trace.length - 1, p + 1))} title="next" data-testid="ir-next">→</button>
        <button className="btn" onClick={() => setPos(trace.length - 1)} title="last">⏭</button>
        <span className="step-count">instr {pos + 1}/{trace.length} · @{cur.fn} {cur.block} · depth {cur.depth}</span>
      </div>
      <pre className="trace-window">
        {window.map((e, k) => (
          <div key={k} className={`trace-row ${base + k === pos ? 'current' : ''}`} onMouseEnter={() => onHover(e.line ? { line: e.line, col: 1, endLine: e.line, endCol: 0 } : null)} onClick={() => setPos(base + k)}>
            <span className="dim">{e.block}</span> {e.text}
          </div>
        ))}
      </pre>
      <h3>Registers (this frame, after this instruction)</h3>
      <div className="reg-grid">
        {(after.depth === cur.depth ? after : cur).regs.slice(-24).map(([id, v]) => (
          <span key={id} className={`reg ${!cur.regs.some(([i, x]) => i === id && x === v) ? 'changed' : ''}`}>
            %{id} = <b>{v}</b>
          </span>
        ))}
        {after.regs.length === 0 && <span className="dim">none defined yet</span>}
      </div>
    </div>
  );
}
