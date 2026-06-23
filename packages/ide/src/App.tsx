import { useEffect, useMemo, useRef, useState } from 'react';
import { Editor, EditorDiagnostic } from './Editor';
import { MemoryView } from './MemoryView';
import { Chat } from './Chat';
import { getEngine } from './ai';
import { EXAMPLES } from './examples';
import { ProjectState, loadProject, saveProject, addFile, removeFile } from './project';
import { analyzeProject, execute, Outcome, Snapshot, AnalyzeResult } from './session';

type PanelTab = 'memory' | 'stack' | 'cpp' | 'problems' | 'assistant';

export function App() {
  const [project, setProject] = useState<ProjectState>(() => loadProject());
  const [breakpoints, setBreakpoints] = useState<Record<string, Set<number>>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [stdin, setStdin] = useState('');
  const [debugStep, setDebugStep] = useState<number | null>(null);
  const [panel, setPanel] = useState<PanelTab>('memory');
  const [gotoLine, setGotoLine] = useState<number | null>(null);

  const active = project.active;
  const activePath = '/home/' + active;

  useEffect(() => saveProject(project), [project]);

  // Debounced background analysis for diagnostics / lens / go-to-def.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        setAnalysis(analyzeProject(project.files, active));
      } catch {
        setAnalysis(null);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [project.files, active]);

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

  const doRun = () => {
    setDebugStep(null);
    setOutcome(execute(project.files, { stdin }));
    setPanel('memory');
  };
  const doDebug = () => {
    const o = execute(project.files, { stdin, trace: true });
    setOutcome(o);
    if (o.snapshots.length > 0) {
      // Jump to the first breakpoint, else start at step 0.
      const first = o.snapshots.findIndex((s) => (breakpoints[fileBase(s.file)] ?? new Set()).has(s.line));
      setDebugStep(first >= 0 ? first : 0);
      setPanel('memory');
    } else {
      setDebugStep(null);
    }
  };
  const stopDebug = () => setDebugStep(null);

  const nav = (predicate: (s: Snapshot, cur: Snapshot) => boolean) => {
    if (!outcome || debugStep === null) return;
    const cur = outcome.snapshots[debugStep]!;
    for (let i = debugStep + 1; i < outcome.snapshots.length; i++) {
      if (predicate(outcome.snapshots[i]!, cur)) {
        setDebugStep(i);
        return;
      }
    }
    setDebugStep(null); // ran off the end → program finished
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
      .map((d) => ({
        line: d.span.start.line,
        col: d.span.start.col,
        endLine: d.span.end.line,
        endCol: d.span.end.col,
        severity: d.severity === 'error' ? 'error' : 'warning',
        message: d.message,
      }));
  }, [analysis, activePath]);

  const currentLine = debugging && snapshot && fileBase(snapshot.file) === active ? snapshot.line : gotoLine;

  const onGotoDef = (line: number, col: number) => {
    if (!analysis) return;
    const link = analysis.defs.find(
      (d) => d.use.start.file === activePath && d.use.start.line === line && col >= d.use.start.col && col <= d.use.end.col + 1,
    );
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
  const insertCode = (code: string) => {
    let n = 1;
    let name = 'snippet.c';
    while (project.files[name] !== undefined) name = `snippet${++n}.c`;
    setProject((p) => ({ files: { ...p.files, [name]: code + '\n' }, active: name }));
  };

  const stdout = debugging && snapshot ? outcome!.stdout.slice(0, snapshot.outLen) : outcome?.stdout ?? '';
  const stderr = outcome?.stderr ?? '';
  const errorCount = analysis?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;

  return (
    <div className="ide">
      <header className="toolbar">
        <span className="brand">Compy</span>
        <button className="btn run" onClick={doRun} data-testid="run">
          ▶ Run
        </button>
        {!debugging ? (
          <button className="btn" onClick={doDebug} data-testid="debug">
            🐞 Debug
          </button>
        ) : (
          <span className="debug-controls">
            <button className="btn" onClick={stepInto} title="Step into">
              ↓
            </button>
            <button className="btn" onClick={stepOver} title="Step over">
              →
            </button>
            <button className="btn" onClick={stepOut} title="Step out">
              ↑
            </button>
            <button className="btn" onClick={continueRun} title="Continue">
              ⏵⏵
            </button>
            <button className="btn stop" onClick={stopDebug} title="Stop">
              ■
            </button>
            <span className="step-count">
              step {(debugStep ?? 0) + 1}/{outcome?.snapshots.length ?? 0}
            </span>
          </span>
        )}
        <select
          className="examples"
          value=""
          onChange={(e) => {
            const ex = EXAMPLES.find((x) => x.name === e.target.value);
            if (ex) {
              setProject({ files: { ...ex.files }, active: Object.keys(ex.files)[0]! });
              setOutcome(null);
              setDebugStep(null);
            }
          }}
        >
          <option value="">Examples…</option>
          {EXAMPLES.map((ex) => (
            <option key={ex.name} value={ex.name}>
              {ex.name}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {errorCount > 0 && <span className="err-count">{errorCount} error(s)</span>}
      </header>

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
            onGotoDef={onGotoDef}
            ghostProvider={ghostProvider}
          />
          <div className="console">
            <div className="console-out" data-testid="console">
              {stdout}
              {stderr && <span className="stderr">{stderr}</span>}
              {outcome && !debugging && outcome.exitCode !== undefined && (
                <div className="exit">→ exited with code {outcome.exitCode}</div>
              )}
            </div>
            <input
              className="stdin"
              placeholder="stdin (fed to the program)…"
              value={stdin}
              onChange={(e) => setStdin(e.target.value)}
            />
          </div>
        </div>

        <div className="panel">
          <div className="panel-tabs">
            {(['memory', 'stack', 'cpp', 'problems', 'assistant'] as PanelTab[]).map((t) => (
              <button key={t} className={panel === t ? 'active' : ''} onClick={() => setPanel(t)}>
                {t === 'memory' ? 'Memory' : t === 'stack' ? 'Call stack' : t === 'cpp' ? 'Preprocessor' : t === 'problems' ? 'Problems' : 'AI'}
              </button>
            ))}
          </div>
          <div className="panel-body">
            {outcome && outcome.faults.length > 0 && (
              <div className="fault-banner">
                ⚠ {outcome.faults.length} memory issue(s): {outcome.faults.map((f) => f.kind).join(', ')}
              </div>
            )}
            {outcome && outcome.leaks.length > 0 && !debugging && (
              <div className="fault-banner leak">💧 {outcome.leaks.length} leaked block(s)</div>
            )}
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
            {panel === 'cpp' && <PreprocessorView analysis={analysis} />}
            {panel === 'problems' && <ProblemsView analysis={analysis} />}
            {panel === 'assistant' && <Chat onInsertCode={insertCode} />}
          </div>
        </div>
      </div>
    </div>
  );
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

function PreprocessorView({ analysis }: { analysis: AnalyzeResult | null }) {
  if (!analysis) return <p className="hint">Analyzing…</p>;
  if (analysis.lens.length === 0) return <p className="hint">No preprocessor activity in this file.</p>;
  return (
    <div>
      <h3>Preprocessor lens</h3>
      <ul className="lens">
        {analysis.lens.map((e, i) => (
          <li key={i} className={`lens-${e.kind}`}>
            <span className="lens-kind">{e.kind}</span> {e.name ?? ''} {e.detail ? <em>{e.detail}</em> : null}
            <span className="mono lens-loc"> :{e.span.start.line}</span>
          </li>
        ))}
      </ul>
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
