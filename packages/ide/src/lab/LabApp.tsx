import { useEffect, useMemo, useState } from 'react';
import { runLab, LabResult, LAB_PRESETS, ParserId, LexerMode, buildTree, fmtTree } from '@compy/lab';
import { Editor, EditorRange } from '../Editor';
import { LabProject, presetToProject } from '../mode';
import { AutomataView } from './AutomataView';
import { LabTokensView } from './LabTokensView';
import { AnalysisView } from './AnalysisView';
import { ParseView, tokenRange } from './ParseView';
import { ParseTree } from './TreeView';
import { LabLearnView } from './LabLearnView';
import { PhaseBar, PhaseStatus } from '../PhaseBar';
import { ErrorBoundary } from '../ErrorBoundary';

/**
 * The Language lab: three documents (lexical rules, grammar, input), a
 * configuration strip, a phase bar, and the panels that draw every
 * construction. No IR, no code generation: the pipeline ends at the tree.
 */
export type LabPhase = 'lex' | 'automata' | 'tokens' | 'grammar' | 'analysis' | 'parse' | 'tree';
type LabPanel = 'automata' | 'tokens' | 'analysis' | 'parse' | 'tree' | 'learn';

interface Props {
  project: LabProject;
  setProject: (p: LabProject | ((p: LabProject) => LabProject)) => void;
}

export function LabApp({ project, setProject }: Props) {
  const [result, setResult] = useState<LabResult | null>(null);
  const [panel, setPanel] = useState<LabPanel>('learn');
  const [highlight, setHighlight] = useState<EditorRange | null>(null);
  const [parsePos, setParsePos] = useState(0);
  const [treeHoverId, setTreeHoverId] = useState<number | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      try {
        setResult(runLab(project.config, project.lex, project.grammar, project.input));
      } catch (e) {
        setResult(null);
        console.error(e);
      }
    }, 200);
    return () => clearTimeout(id);
  }, [project.config, project.lex, project.grammar, project.input]);
  useEffect(() => setParsePos(0), [result?.parse]);

  const cfg = project.config;
  const setCfg = (patch: Partial<typeof cfg>) => setProject((p) => ({ ...p, config: { ...p.config, ...patch } }));
  const docText = project[project.active];
  const setDoc = (text: string) => setProject((p) => ({ ...p, [p.active]: text }));

  const phases: PhaseStatus[] = useMemo(() => {
    const r = result;
    const lexErr = r?.problems.filter((p) => p.phase === 'lexer').length ?? 0;
    const gErr = r?.problems.filter((p) => p.phase === 'grammar').length ?? 0;
    const out: PhaseStatus[] = [
      { id: 'tokens' as never, label: 'Lexer spec', detail: cfg.lexerMode === 'rules' ? `${r?.spec?.rules.filter((x) => !x.generated).length ?? 0} rules` : cfg.lexerMode === 'chars' ? 'characters' : 'tokens given', error: lexErr > 0 },
      { id: 'preprocess' as never, label: 'Automata', detail: r?.lexer ? `${r.lexer.states.reduce((n, s) => n + s.minimal.states, 0)} DFA states` : '—' },
      { id: 'ast' as never, label: 'Tokens', detail: r ? `${r.tokens.length} tokens${r.lex.errors.length ? `, ${r.lex.errors.length} error(s)` : ''}` : '…', error: (r?.lex.errors.length ?? 0) > 0 },
    ];
    if (cfg.stage === 'parser') {
      out.push(
        { id: 'types' as never, label: 'Grammar', detail: r?.grammar ? `${r.grammar.productions.length} productions` : '…', error: gErr > 0 },
        { id: 'ir' as never, label: 'Analysis', detail: r?.checks.length ? (r.checks[0]!.kind === 'ok' ? 'clean' : `${r.checks.filter((c) => c.kind !== 'ok').length} issue(s)`) : '—' },
        { id: 'optimize' as never, label: 'Parse', detail: r?.parse ? (r.parse.accepted ? 'accepted' : 'rejected') : r?.problems.some((p) => p.phase === 'parser') ? 'blocked' : '—', error: r?.parse ? !r.parse.accepted : false },
        { id: 'asm' as never, label: 'Tree', detail: r?.parse?.accepted ? `${r.parse.treeOps.filter((o) => o.op === 'node').length} nodes` : '—' },
      );
    }
    return out;
  }, [result, cfg]);
  const phaseToPanel: Record<string, { panel: LabPanel; doc: LabProject['active'] }> = {
    tokens: { panel: 'tokens', doc: 'lex' },
    preprocess: { panel: 'automata', doc: 'lex' },
    ast: { panel: 'tokens', doc: 'input' },
    types: { panel: 'analysis', doc: 'grammar' },
    ir: { panel: 'analysis', doc: 'grammar' },
    optimize: { panel: 'parse', doc: 'input' },
    asm: { panel: 'tree', doc: 'input' },
  };
  const panelToPhase: Record<LabPanel, string | null> = { automata: 'preprocess', tokens: 'ast', analysis: 'ir', parse: 'optimize', tree: 'asm', learn: null };

  const fullTree = useMemo(() => (result?.parse ? buildTree(result.parse.treeOps) : null), [result]);
  const problems = result?.problems ?? [];

  return (
    <>
      <div className="lab-config">
        <label>
          lexer{' '}
          <select value={cfg.lexerMode} onChange={(e) => setCfg({ lexerMode: e.target.value as LexerMode })} data-testid="lexer-mode">
            <option value="rules">rules (tokens.lex)</option>
            <option value="chars">characters (each char is a token)</option>
            <option value="given">tokens given directly</option>
          </select>
        </label>
        <label>
          stage{' '}
          <select value={cfg.stage} onChange={(e) => setCfg({ stage: e.target.value as 'lexer' | 'parser' })} data-testid="stage">
            <option value="lexer">lexer only</option>
            <option value="parser">lexer + parser</option>
          </select>
        </label>
        {cfg.lexerMode === 'chars' && (
          <label>
            <input type="checkbox" checked={cfg.skipWhitespace ?? true} onChange={(e) => setCfg({ skipWhitespace: e.target.checked })} /> skip whitespace
          </label>
        )}
        <select
          className="examples examples-menu"
          data-testid="lab-presets"
          value=""
          onChange={(e) => {
            const p = LAB_PRESETS.find((x) => x.name === e.target.value);
            if (p) {
              setProject(presetToProject(p));
              setPanel(p.stage === 'lexer' ? 'tokens' : 'parse');
            }
          }}
        >
          <option value="">Presets…</option>
          {[...new Set(LAB_PRESETS.map((p) => p.category))].map((cat) => (
            <optgroup key={cat} label={cat}>
              {LAB_PRESETS.filter((p) => p.category === cat).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="spacer" />
        {problems.length > 0 && <span className="err-count">{problems.length} problem(s)</span>}
      </div>
      <PhaseBar
        phases={phases}
        active={(panelToPhase[panel] as never) ?? null}
        onSelect={(id) => {
          const t = phaseToPanel[id];
          if (!t) return;
          setPanel(t.panel);
          setProject((p) => ({ ...p, active: t.doc }));
        }}
      />
      <div className="tabs">
        {(['lex', 'grammar', 'input'] as const)
          .filter((d) => (d === 'lex' ? cfg.lexerMode === 'rules' : d === 'grammar' ? cfg.stage === 'parser' : true))
          .map((d) => (
            <div key={d} className={`tab ${project.active === d ? 'active' : ''}`} onClick={() => setProject((p) => ({ ...p, active: d }))} data-testid={`doc-${d}`}>
              {d === 'lex' ? 'tokens.lex' : d === 'grammar' ? 'grammar.cfg' : 'input.txt'}
            </div>
          ))}
      </div>
      <div className="main">
        <div className="editor-pane">
          <Editor
            key={project.active}
            doc={docText}
            onChange={setDoc}
            breakpoints={new Set()}
            onToggleBreakpoint={() => {}}
            diagnostics={problems
              .filter((p) => p.line !== undefined && ((p.phase === 'lexer' && project.active === 'lex') || (p.phase === 'grammar' && project.active === 'grammar')))
              .map((p) => ({ line: p.line!, col: 1, endLine: p.line!, endCol: 200, severity: 'error' as const, message: p.message }))}
            currentLine={null}
            highlight={project.active === 'input' ? highlight : null}
            onGotoDef={() => {}}
            language="plain"
            noGutter
          />
          <div className="console lab-problems">
            <div className="console-out" data-testid="lab-problems">
              {problems.length === 0 ? (
                <span className="dim">{result ? `✓ ${result.tokens.length} tokens${result.parse ? `, parse ${result.parse.accepted ? 'accepted' : 'rejected'}` : ''}` : 'analysing…'}</span>
              ) : (
                problems.map((p, k) => (
                  <div key={k} className="stderr">
                    [{p.phase}{p.line ? ` line ${p.line}` : ''}] {p.message}
                  </div>
                ))
              )}
              {result?.parse?.accepted && fullTree && fullTree.roots.length === 1 && <div className="exit mono">{fmtTree(fullTree.nodes, fullTree.roots[0]!)}</div>}
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-tabs">
            {(['learn', 'automata', 'tokens', 'analysis', 'parse', 'tree'] as LabPanel[])
              .filter((p) => cfg.stage === 'parser' || !['analysis', 'parse', 'tree'].includes(p))
              .map((p) => (
                <button key={p} className={panel === p ? 'active' : ''} onClick={() => setPanel(p)} data-testid={`lab-tab-${p}`}>
                  {p === 'learn' ? 'Learn' : p === 'automata' ? 'Automata' : p === 'tokens' ? 'Tokens' : p === 'analysis' ? 'Analysis' : p === 'parse' ? 'Parse' : 'Tree'}
                </button>
              ))}
          </div>
          <div className="panel-body">
            <ErrorBoundary label={panel + ' panel'}>
            {panel === 'learn' && (
              <LabLearnView
                onLoad={(p) => {
                  setProject(presetToProject(p));
                }}
                onOpenPanel={(p) => setPanel(p)}
              />
            )}
            {panel === 'automata' && <AutomataView lexer={result?.lexer ?? null} lexerMode={cfg.lexerMode} />}
            {panel === 'tokens' && result && <LabTokensView result={result} input={project.input} onHover={setHighlight} />}
            {panel === 'analysis' && result && <AnalysisView result={result} onApplyGrammar={(text) => setProject((p) => ({ ...p, grammar: text, active: 'grammar' }))} />}
            {panel === 'parse' && result && (
              <ParseView result={result} input={project.input} parser={cfg.parser} onParserChange={(parser: ParserId) => setCfg({ parser })} pos={parsePos} onPos={setParsePos} onHover={setHighlight} showTree />
            )}
            {panel === 'tree' && result && (
              <div data-testid="tree">
                {fullTree && fullTree.roots.length ? (
                  <>
                    <p className="hint">{result.parse?.accepted ? `The complete parse tree${result.parse.parses && result.parse.parses > 1 ? ` (one of ${result.parse.parses})` : ''}. Hover a node to see its input span.` : 'The partial tree at the point the parser failed.'}</p>
                    <ParseTree
                      nodes={fullTree.nodes}
                      roots={fullTree.roots}
                      highlightLatest={false}
                      onHover={(n) => {
                        setTreeHoverId(n?.id ?? null);
                        if (n?.token) setHighlight(tokenRange(project.input, n.token));
                        else if (n) {
                          // Highlight the span covered by the node's leaves.
                          const leaves: number[] = [];
                          const walk = (id: number) => {
                            const x = fullTree.nodes.get(id);
                            if (!x) return;
                            if (x.token) leaves.push(x.token.start, x.token.end);
                            x.children.forEach(walk);
                          };
                          walk(n.id);
                          if (leaves.length) {
                            const start = Math.min(...leaves);
                            const end = Math.max(...leaves);
                            setHighlight(tokenRange(project.input, { name: '', text: '', start, end, line: 1, col: 1 }));
                          }
                        } else setHighlight(null);
                      }}
                    />
                    {fullTree.roots.length === 1 && <div className="mono dim sentential">{fmtTree(fullTree.nodes, fullTree.roots[0]!)}</div>}
                    {treeHoverId !== null && <span className="dim">node #{treeHoverId}</span>}
                  </>
                ) : (
                  <p className="hint">Parse an input to see its tree.</p>
                )}
              </div>
            )}
            </ErrorBoundary>
          </div>
        </div>
      </div>
    </>
  );
}
