import { useEffect, useMemo, useState } from 'react';
import { Editor, EditorDiagnostic, EditorRange } from './Editor';
import { MemoryView } from './MemoryView';
import { Chat } from './Chat';
import { getEngine } from './ai';
import { EXAMPLES } from './examples';
import { ProjectState, loadProject, saveProject, addFile, removeFile } from './project';
import { analyzeProject, execute, Outcome, Snapshot, AnalyzeResult, Engine, CompileSettings, DEFAULT_SETTINGS } from './session';
import { PhaseBar, PhaseId, PhaseStatus } from './PhaseBar';
import { TokensView } from './TokensView';
import { AstView } from './AstView';
import { TypesView } from './TypesView';
import { IrView } from './IrView';
import { OptView } from './OptView';
import { AsmView } from './AsmView';
import { LearnView } from './LearnView';
import { Phase } from './lessons';
import type { PassId } from '@compy/ir';
import type React from 'react';
import { Mode, loadMode, saveMode, LabProject, loadLabProject, saveLabProject } from './mode';
import { LabApp } from './lab/LabApp';
import { ErrorBoundary } from './ErrorBoundary';

/** The product switch: the C89 compiler, or the language lab. */
export function App() {
  const [mode, setMode] = useState<Mode>(() => loadMode());
  const [lab, setLab] = useState<LabProject>(() => loadLabProject());
  useEffect(() => saveMode(mode), [mode]);
  useEffect(() => saveLabProject(lab), [lab]);
  useEffect(() => {
    (window as unknown as { __compyMode?: unknown }).__compyMode = {
      setMode: (m: Mode) => setMode(m),
      loadLab: (p: Partial<LabProject>) => setLab((cur) => ({ ...cur, ...p, config: { ...cur.config, ...(p.config ?? {}) } })),
    };
  });
  const modeSwitch = (
    <span className="mode-switch" data-testid="mode-switch">
      <button className={mode === 'c89' ? 'active' : ''} onClick={() => setMode('c89')} data-testid="mode-c89" title="Compile C89 through every phase to RISC-V">
        C89 compiler
      </button>
      <button className={mode === 'lab' ? 'active' : ''} onClick={() => setMode('lab')} data-testid="mode-lab" title="Your own tokens, grammar and parser: automata and parsing theory">
        Language lab
      </button>
    </span>
  );
  if (mode === 'lab') {
    return (
      <div className="ide">
        <header className="toolbar">
          <span className="brand" title="Compy — language lab">Compy</span>
          {modeSwitch}
          <span className="dim lab-tagline">define a lexer and a grammar, then watch the automata and parsers work</span>
        </header>
        <LabApp project={lab} setProject={setLab} />
      </div>
    );
  }
  return <CompilerApp modeSwitch={modeSwitch} />;
}

type PanelTab = PhaseId | 'memory' | 'stack' | 'problems' | 'assistant' | 'learn';

const ENGINE_LABEL: Record<Engine, string> = { ast: 'AST interpreter', ir: 'IR interpreter', machine: 'RISC-V simulator' };
const PHASE_OF_LESSON: Record<Phase, PanelTab> = { lex: 'tokens', preprocess: 'preprocess', parse: 'ast', sema: 'types', ir: 'ir', opt: 'optimize', codegen: 'asm', run: 'memory' };

export function CompilerApp({ modeSwitch }: { modeSwitch: React.ReactNode }) {
  const [project, setProject] = useState<ProjectState>(() => loadProject());
  const [breakpoints, setBreakpoints] = useState<Record<string, Set<number>>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [stdin, setStdin] = useState('');
  const [debugStep, setDebugStep] = useState<number | null>(null);
  /** True once stepping ran past the last statement: the program has finished but the session stays open. */
  const [debugDone, setDebugDone] = useState(false);
  const [panel, setPanel] = useState<PanelTab>('learn');
  const [gotoLine, setGotoLine] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<EditorRange | null>(null);
  const [engine, setEngine] = useState<Engine>('ast');
  const [settings, setSettings] = useState<CompileSettings>(DEFAULT_SETTINGS);

  const active = project.active;
  const activePath = '/home/' + active;

  useEffect(() => saveProject(project), [project]);

  // Debounced background compilation: every phase, for every panel.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        setAnalysis(analyzeProject(project.files, active, settings));
      } catch {
        setAnalysis(null);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [project.files, active, settings]);

  const setActiveDoc = (doc: string) => setProject((p) => ({ ...p, files: { ...p.files, [p.active]: doc } }));
  const bpSet = breakpoints[active] ?? new Set<number>();
  const toggleBp = (line: number) =>
    setBreakpoints((b) => {
      const s = new Set(b[active] ?? []);
      if (s.has(line)) s.delete(line);
      else s.add(line);
      return { ...b, [active]: s };
    });

  const snapshot: Snapshot | null = outcome && debugStep !== null ? outcome.snapshots[debugStep] ?? null : null;
  const debugging = snapshot !== null;

  // -- run / debug -----------------------------------------------------------

  const runWith = (eng: Engine, trace: boolean): Outcome => execute(project.files, { stdin, trace, engine: eng, settings });
  const doRun = () => {
    setDebugStep(null);
    setDebugDone(false);
    setOutcome(runWith(engine, false));
    if (!['memory', 'stack', 'problems'].includes(panel)) setPanel('memory');
  };
  const doDebug = (eng: Engine = engine) => {
    const o = runWith(eng, true);
    setOutcome(o);
    setDebugDone(false);
    if (o.snapshots.length > 0) {
      const first = o.snapshots.findIndex((s) => (breakpoints[fileBase(s.file)] ?? new Set()).has(s.line));
      setDebugStep(first >= 0 ? first : 0);
      if (!['memory', 'stack', 'ir', 'asm'].includes(panel)) setPanel('memory');
    } else setDebugStep(null);
  };
  const stopDebug = () => {
    setDebugStep(null);
    setDebugDone(false);
  };
  const traceOn = (eng: Engine) => {
    setEngine(eng);
    doDebug(eng);
  };

  const nav = (predicate: (s: Snapshot, cur: Snapshot) => boolean) => {
    if (!outcome || debugStep === null) return;
    const cur = outcome.snapshots[debugStep]!;
    for (let i = debugStep + 1; i < outcome.snapshots.length; i++) {
      if (predicate(outcome.snapshots[i]!, cur)) {
        setDebugStep(i);
        setDebugDone(false);
        return;
      }
    }
    // Ran off the end: stay at the last snapshot so the student can step back.
    setDebugStep(outcome.snapshots.length - 1);
    setDebugDone(true);
  };
  const stepBack = () => {
    setDebugDone(false);
    setDebugStep((s) => (s === null ? null : Math.max(0, s - 1)));
  };
  const stepInto = () => nav(() => true);
  const stepOver = () => nav((s, cur) => s.depth <= cur.depth);
  const stepOut = () => nav((s, cur) => s.depth < cur.depth);
  const continueRun = () => nav((s) => (breakpoints[fileBase(s.file)] ?? new Set()).has(s.line));

  // -- editor data -----------------------------------------------------------

  const editorDiags: EditorDiagnostic[] = useMemo(() => {
    if (!analysis) return [];
    return analysis.diagnostics
      .filter((d) => d.span.start.file === activePath)
      .map((d) => ({ line: d.span.start.line, col: d.span.start.col, endLine: d.span.end.line, endCol: d.span.end.col, severity: d.severity === 'error' ? 'error' : 'warning', message: d.message }));
  }, [analysis, activePath]);

  const currentLine = debugging && snapshot && fileBase(snapshot.file) === active ? snapshot.line : gotoLine;

  const onGotoDef = (line: number, col: number) => {
    if (!analysis) return;
    const link = analysis.defs.find((d) => d.use.start.file === activePath && d.use.start.line === line && col >= d.use.start.col && col <= d.use.end.col + 1);
    if (!link) return;
    const declFile = fileBase(link.decl.start.file);
    if (project.files[declFile] !== undefined) setProject((p) => ({ ...p, active: declFile }));
    setGotoLine(link.decl.start.line);
    setTimeout(() => setGotoLine(null), 1500);
  };

  const ghostProvider = (before: string, after: string): Promise<string> => {
    const e = getEngine();
    return e ? e.complete(before, after) : Promise.resolve('');
  };
  const insertCode = (code: string, preferred = 'snippet.c') => {
    // A whole program (it defines main) becomes the project; a fragment is added as a file.
    if (/\bmain\s*\(/.test(code)) {
      loadExample({ [preferred]: code.endsWith('\n') ? code : code + '\n' });
      return;
    }
    let n = 1;
    let name = preferred;
    while (project.files[name] !== undefined) name = preferred.replace(/\.c$/, '') + `${++n}.c`;
    setProject((p) => ({ files: { ...p.files, [name]: code.endsWith('\n') ? code : code + '\n' }, active: name }));
    setOutcome(null);
    setDebugStep(null);
  };
  const loadExample = (files: Record<string, string>) => {
    setProject({ files: { ...files }, active: Object.keys(files)[0]! });
    setOutcome(null);
    setDebugStep(null);
  };
  // Test hook: lets the end-to-end suite load arbitrary programs and settings.
  useEffect(() => {
    (window as unknown as { __compy?: unknown }).__compy = {
      load: (files: Record<string, string>) => loadExample(files),
      setEngine: (e: Engine) => setEngine(e),
      setStdin: (s: string) => setStdin(s),
      setPanel: (p: PanelTab) => setPanel(p),
      setPasses: (passes: PassId[]) => setSettings((s) => ({ ...s, passes })),
    };
  });

  const stdout = debugging && snapshot && !debugDone ? outcome!.stdout.slice(0, snapshot.outLen) : outcome?.stdout ?? '';
  const stderr = outcome?.stderr ?? '';
  const errorCount = analysis?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;

  const phases: PhaseStatus[] = useMemo(() => {
    const a = analysis;
    const fnCount = a?.ir?.functions.length ?? 0;
    const irInstrs = a?.ir ? a.ir.functions.reduce((n, f) => n + f.blocks.reduce((m, b) => m + b.instrs.length, 0), 0) : 0;
    const optInstrs = a?.opt ? a.opt.module.functions.reduce((n, f) => n + f.blocks.reduce((m, b) => m + b.instrs.length, 0), 0) : 0;
    const asmLines = a?.cg ? a.cg.mmod.functions.reduce((n, f) => n + f.blocks.reduce((m, b) => m + b.instrs.length, 0), 0) : 0;
    const semaErrs = a?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;
    return [
      { id: 'source', label: 'Source', detail: `${Object.keys(project.files).length} file(s)` },
      { id: 'tokens', label: 'Tokens', detail: a ? `${a.tokens.length - 1} tokens` : '…' },
      { id: 'preprocess', label: 'Preprocess', detail: a ? `${a.lens.length} events` : '…' },
      { id: 'ast', label: 'Parse', detail: a ? `${a.activeUnit.decls.length} decl(s)` : '…' },
      { id: 'types', label: 'Types', detail: semaErrs ? `${semaErrs} error(s)` : 'ok', error: semaErrs > 0 },
      { id: 'ir', label: 'IR', detail: a?.ir ? `${fnCount} fn, ${irInstrs} instr` : '—' },
      { id: 'optimize', label: 'Optimize', detail: a?.opt ? `→ ${optInstrs} instr` : '—' },
      { id: 'asm', label: 'Codegen', detail: a?.cg ? `${asmLines} RV32 instr` : a?.cgError ? 'failed' : '—', error: !!a?.cgError },
      { id: 'run', label: 'Run', detail: outcome ? `exit ${outcome.exitCode ?? '?'} (${ENGINE_LABEL[outcome.engine].split(' ')[0]})` : 'not run' },
    ];
  }, [analysis, project.files, outcome]);

  const onPhase = (p: PhaseId) => {
    if (p === 'source') return;
    if (p === 'run') {
      setPanel('memory');
      return;
    }
    setPanel(p);
  };

  const panelTabs: { id: PanelTab; label: string }[] = [
    { id: 'learn', label: 'Learn' },
    { id: 'memory', label: 'Memory' },
    { id: 'stack', label: 'Call stack' },
    { id: 'problems', label: 'Problems' },
    { id: 'assistant', label: 'AI' },
  ];
  const activeTab: PanelTab = panel;

  return (
    <div className="ide">
      <header className="toolbar">
        <span className="brand" title="Compy — see how a compiler works">Compy</span>
        {modeSwitch}
        <button className="btn run" onClick={doRun} data-testid="run">
          ▶ Run
        </button>
        {!debugging ? (
          <button className="btn" onClick={() => doDebug()} data-testid="debug">
            🐞 Debug
          </button>
        ) : (
          <span className="debug-controls">
            <button className="btn" onClick={stepBack} title="Step back">↶</button>
            <button className="btn" onClick={stepInto} title="Step into">↓</button>
            <button className="btn" onClick={stepOver} title="Step over">→</button>
            <button className="btn" onClick={stepOut} title="Step out">↑</button>
            <button className="btn" onClick={continueRun} title="Continue">⏵⏵</button>
            <button className="btn stop" onClick={stopDebug} title="Stop">■</button>
            <span className="step-count">
              step {(debugStep ?? 0) + 1}/{outcome?.snapshots.length ?? 0}
              {debugDone && <span className="done-tag"> · finished, exit {outcome?.exitCode ?? '?'}</span>}
            </span>
          </span>
        )}
        <select className="examples engine-select" value={engine} onChange={(e) => setEngine(e.target.value as Engine)} title="Which engine executes the program" data-testid="engine">
          {(Object.keys(ENGINE_LABEL) as Engine[]).map((e) => (
            <option key={e} value={e}>
              run on: {ENGINE_LABEL[e]}
            </option>
          ))}
        </select>
        <select
          className="examples examples-menu"
          data-testid="examples"
          value=""
          onChange={(e) => {
            const ex = EXAMPLES.find((x) => x.name === e.target.value);
            if (ex) loadExample(ex.files);
          }}
        >
          <option value="">Examples…</option>
          {groupBy(EXAMPLES, (x) => x.category).map(([cat, items]) => (
            <optgroup key={cat} label={cat}>
              {items.map((ex) => (
                <option key={ex.name} value={ex.name}>
                  {ex.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="spacer" />
        {errorCount > 0 && <span className="err-count">{errorCount} error(s)</span>}
      </header>

      <PhaseBar phases={phases} active={(['tokens', 'preprocess', 'ast', 'types', 'ir', 'optimize', 'asm'] as PanelTab[]).includes(panel) ? (panel as PhaseId) : panel === 'memory' || panel === 'stack' ? 'run' : null} onSelect={onPhase} />

      <div className="tabs">
        {Object.keys(project.files).map((name) => (
          <div key={name} className={`tab ${name === active ? 'active' : ''}`} onClick={() => setProject((p) => ({ ...p, active: name }))}>
            {name}
            {Object.keys(project.files).length > 1 && (
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  setProject((p) => removeFile(p, name));
                }}
              >
                ×
              </span>
            )}
          </div>
        ))}
        <div
          className="tab add"
          onClick={() => {
            const name = prompt('New file name (e.g. util.c or util.h):');
            if (name) setProject((p) => addFile(p, name));
          }}
        >
          +
        </div>
      </div>

      <div className="main">
        <div className="editor-pane">
          <Editor
            key={active}
            doc={project.files[active] ?? ''}
            onChange={setActiveDoc}
            breakpoints={bpSet}
            onToggleBreakpoint={toggleBp}
            diagnostics={editorDiags}
            currentLine={currentLine}
            highlight={highlight}
            onGotoDef={onGotoDef}
            ghostProvider={ghostProvider}
          />
          <div className="console">
            <div className="console-out" data-testid="console">
              {stdout}
              {stderr && <span className="stderr">{stderr}</span>}
              {outcome && (!debugging || debugDone) && outcome.exitCode !== undefined && (
                <div className="exit">
                  → exited with code {outcome.exitCode} on the {ENGINE_LABEL[outcome.engine]}
                  {outcome.steps ? ` after ${outcome.steps.toLocaleString()} ${outcome.engine === 'ir' ? 'IR instructions' : 'machine instructions'}` : ''}
                </div>
              )}
            </div>
            <input className="stdin" placeholder="stdin (fed to the program)…" value={stdin} onChange={(e) => setStdin(e.target.value)} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-tabs">
            {panelTabs.map((t) => (
              <button key={t.id} className={activeTab === t.id ? 'active' : ''} onClick={() => setPanel(t.id)}>
                {t.label}
              </button>
            ))}
            {!panelTabs.some((t) => t.id === activeTab) && <button className="active phase-tab">{phases.find((p) => p.id === activeTab)?.label ?? activeTab}</button>}
          </div>
          <div className="panel-body">
            <ErrorBoundary label={panel + ' panel'}>
            {outcome && outcome.faults.length > 0 && (panel === 'memory' || panel === 'stack') && (
              <div className="fault-banner">⚠ {outcome.faults.length} memory issue(s): {outcome.faults.map((f) => f.kind).join(', ')}</div>
            )}
            {outcome && outcome.leaks.length > 0 && !debugging && (panel === 'memory' || panel === 'stack') && <div className="fault-banner leak">💧 {outcome.leaks.length} leaked block(s)</div>}
            {panel === 'learn' && <LearnView onLoad={(code, name) => loadExample({ [name]: code.endsWith('\n') ? code : code + '\n' })} onOpenPhase={(ph) => setPanel(PHASE_OF_LESSON[ph])} />}
            {panel === 'memory' && (
              <MemoryView
                segments={snapshot?.segments ?? outcome?.segments ?? []}
                locals={snapshot?.locals ?? []}
                globals={snapshot?.globals ?? outcome?.globals ?? []}
                heap={snapshot?.heap ?? outcome?.heap ?? []}
                mem={outcome?.mem ?? null}
              />
            )}
            {panel === 'stack' && <CallStackView snapshot={snapshot} />}
            {panel === 'tokens' && analysis && <TokensView tokens={analysis.tokens} ppTokens={analysis.ppTokens} activePath={activePath} onHover={setHighlight} />}
            {panel === 'preprocess' && <PreprocessorView analysis={analysis} onHover={setHighlight} />}
            {panel === 'ast' && analysis && (
              <AstView
                unit={analysis.activeUnit}
                sema={analysis.activeSema}
                activePath={activePath}
                onHover={setHighlight}
                onSelect={(r) => {
                  setGotoLine(r.line);
                  setTimeout(() => setGotoLine(null), 1200);
                }}
              />
            )}
            {panel === 'types' && analysis && <TypesView unit={analysis.activeUnit} sema={analysis.activeSema} diagnostics={analysis.diagnostics} activePath={activePath} onHover={setHighlight} />}
            {panel === 'ir' && (
              <IrView ir={analysis?.ir ?? null} optimized={analysis?.opt?.module ?? null} onHover={setHighlight} trace={outcome?.irTrace ?? []} traceEngine={outcome?.engine === 'ir'} onRequestTrace={() => traceOn('ir')} />
            )}
            {panel === 'optimize' && <OptView ir={analysis?.ir ?? null} opt={analysis?.opt ?? null} passes={settings.passes} onPassesChange={(passes) => setSettings((s) => ({ ...s, passes }))} />}
            {panel === 'asm' && (
              <AsmView
                cg={analysis?.cg ?? null}
                cgError={analysis?.cgError ?? null}
                strategy={settings.strategy}
                onStrategyChange={(strategy) => setSettings((s) => ({ ...s, strategy }))}
                onHover={setHighlight}
                trace={outcome?.machTrace ?? []}
                traceActive={outcome?.engine === 'machine'}
                onRequestTrace={() => traceOn('machine')}
              />
            )}
            {panel === 'problems' && <ProblemsView analysis={analysis} />}
            {panel === 'assistant' && <Chat onInsertCode={(c) => insertCode(c)} />}
            </ErrorBoundary>
          </div>
        </div>
      </div>
    </div>
  );
}

function groupBy<T>(items: T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), it]);
  return [...m.entries()];
}

function fileBase(path: string): string {
  return path.replace(/^.*\//, '');
}

function CallStackView({ snapshot }: { snapshot: Snapshot | null }) {
  if (!snapshot) return <p className="hint">Start debugging to see the call stack.</p>;
  return (
    <div>
      <h3>Call stack</h3>
      <ol className="callstack">
        {snapshot.callStack
          .slice()
          .reverse()
          .map((f, i) => (
            <li key={i} className={i === 0 ? 'top' : ''}>
              {f.name} <span className="mono">line {f.line}</span>
            </li>
          ))}
      </ol>
    </div>
  );
}

function PreprocessorView({ analysis, onHover }: { analysis: AnalyzeResult | null; onHover: (r: EditorRange | null) => void }) {
  if (!analysis) return <p className="hint">Analyzing…</p>;
  const expanded = analysis.ppTokens.filter((t) => t.fromMacro).length;
  return (
    <div>
      <h3>Preprocessor lens</h3>
      <p className="hint">
        Translation phase 4: directives run and macros expand before the parser sees anything. {expanded} token(s) in this file came out of a macro.
      </p>
      {analysis.lens.length === 0 ? (
        <p className="hint">No preprocessor activity in this file.</p>
      ) : (
        <ul className="lens" onMouseLeave={() => onHover(null)}>
          {analysis.lens.map((e, i) => (
            <li key={i} className={`lens-${e.kind}`} onMouseEnter={() => onHover({ line: e.span.start.line, col: e.span.start.col, endLine: e.span.end.line, endCol: e.span.end.col })}>
              <span className="lens-kind">{e.kind}</span> {e.name ?? ''} {e.detail ? <em>{e.detail}</em> : null}
              <span className="mono lens-loc"> :{e.span.start.line}</span>
            </li>
          ))}
        </ul>
      )}
      <h3>Output stream</h3>
      <div className="pp-stream" onMouseLeave={() => onHover(null)}>
        {analysis.ppTokens
          .filter((t) => t.kind !== 'eof')
          .map((t, k) => (
            <span
              key={k}
              className={`tok ${t.fromMacro ? 'from-macro' : ''} ${t.span.start.file.startsWith('/usr/include') ? 'from-header' : ''}`}
              title={t.fromMacro ? `from macro ${t.fromMacro}` : t.span.start.file}
              onMouseEnter={() => (t.span.start.file.startsWith('/usr/include') ? onHover(null) : onHover({ line: t.span.start.line, col: t.span.start.col, endLine: t.span.end.line, endCol: t.span.end.col }))}
            >
              {t.atBol && k > 0 ? '\n' : t.spaceBefore ? ' ' : ''}
              {t.value}
            </span>
          ))}
      </div>
      <p className="hint">Dimmed tokens came from a header; highlighted ones from a macro expansion.</p>
    </div>
  );
}

function ProblemsView({ analysis }: { analysis: AnalyzeResult | null }) {
  if (!analysis) return <p className="hint">Analyzing…</p>;
  if (analysis.diagnostics.length === 0) return <p className="hint">No problems. ✓</p>;
  return (
    <ul className="problems">
      {analysis.diagnostics.map((d, i) => (
        <li key={i} className={d.severity}>
          <span className="sev">{d.severity}</span>
          <span className="msg">{d.message}</span>
          <span className="mono loc">
            {fileBase(d.span.start.file)}:{d.span.start.line}
          </span>
        </li>
      ))}
    </ul>
  );
}
