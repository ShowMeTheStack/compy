import { useMemo, useState } from 'react';
import { Token, isKeyword } from '@compy/cc';
import { EditorRange } from './Editor';

/**
 * Phase 1–4 panel: the token stream. Raw tokens come straight from the
 * lexer (translation phases 1–3); the preprocessed stream shows what the
 * parser will actually see, with macro-expanded tokens marked.
 */
interface Props {
  tokens: Token[];
  ppTokens: Token[];
  activePath: string;
  onHover: (r: EditorRange | null) => void;
}

function kindOf(t: Token): string {
  if (t.kind === 'id') return isKeyword(t.value) ? 'keyword' : 'identifier';
  if (t.kind === 'ppnum') return /[.eE]|^0[xX].*[pP]/.test(t.value) && !/^0[xX]/.test(t.value) ? 'float' : 'number';
  return t.kind;
}

const KIND_HELP: Record<string, string> = {
  keyword: 'A reserved word. The lexer emits it as an identifier; the parser recognises it as a keyword (translation phase 7).',
  identifier: 'A name: variable, function, type, or macro. Which one it is, the lexer does not know.',
  number: 'A pp-number. Its value and type (int, unsigned, long…) are decided later from its suffix and magnitude.',
  float: 'A floating pp-number: has a decimal point or exponent.',
  char: 'A character constant; in C its type is int.',
  string: 'A string literal: becomes a NUL-terminated char array in read-only memory.',
  punct: 'An operator or punctuator, found by maximal munch: the longest match wins (so `a+++b` is `a ++ + b`).',
  other: 'A stray character the C grammar has no use for.',
  header: 'A header name, only recognised inside #include.',
  eof: 'End of file.',
};

export function TokensView({ tokens, ppTokens, activePath, onHover }: Props) {
  const [mode, setMode] = useState<'raw' | 'pp'>('raw');
  const list = mode === 'raw' ? tokens : ppTokens;
  const own = useMemo(() => list.filter((t) => t.kind !== 'eof' && (mode === 'raw' || t.span.start.file === activePath || t.fromMacro)), [list, mode, activePath]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const t of own) c.set(kindOf(t), (c.get(kindOf(t)) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [own]);
  const [sel, setSel] = useState<number | null>(null);

  let lastLine = -1;
  return (
    <div className="tokens" data-testid="tokens">
      <div className="panel-toolbar">
        <label>
          <input type="radio" checked={mode === 'raw'} onChange={() => setMode('raw')} /> raw (phases 1–3)
        </label>
        <label>
          <input type="radio" checked={mode === 'pp'} onChange={() => setMode('pp')} /> after preprocessing
        </label>
        <span className="spacer" />
        <span className="dim">{own.length} tokens</span>
      </div>
      <div className="token-stats">
        {counts.map(([k, n]) => (
          <span key={k} className={`tok tok-${k}`} title={KIND_HELP[k]}>
            {k} <b>{n}</b>
          </span>
        ))}
      </div>
      <div className="token-stream" onMouseLeave={() => onHover(null)}>
        {own.map((t, k) => {
          const kind = kindOf(t);
          const newLine = t.span.start.line !== lastLine && mode === 'raw';
          lastLine = t.span.start.line;
          const range: EditorRange = { line: t.span.start.line, col: t.span.start.col, endLine: t.span.end.line, endCol: t.span.end.col };
          return (
            <span key={k} style={{ display: 'contents' }}>
              {newLine && <span className="token-line">{t.span.start.line}</span>}
              <span
                className={`tok tok-${kind} ${t.fromMacro ? 'from-macro' : ''} ${sel === k ? 'selected' : ''}`}
                title={`${kind}${t.fromMacro ? ` (from macro ${t.fromMacro})` : ''} @ ${t.span.start.line}:${t.span.start.col}`}
                onMouseEnter={() => onHover(range)}
                onClick={() => setSel(k)}
              >
                {t.value}
              </span>
            </span>
          );
        })}
      </div>
      {sel !== null && own[sel] && (
        <div className="token-detail">
          <b>{kindOf(own[sel]!)}</b> <code>{own[sel]!.value}</code> — {KIND_HELP[kindOf(own[sel]!)]}
          {own[sel]!.fromMacro && (
            <div>
              Produced by expanding macro <code>{own[sel]!.fromMacro}</code>.
            </div>
          )}
          <div className="dim">
            span {own[sel]!.span.start.line}:{own[sel]!.span.start.col}–{own[sel]!.span.end.line}:{own[sel]!.span.end.col}
            {own[sel]!.spaceBefore ? ' · whitespace before' : ''}
            {own[sel]!.atBol ? ' · first on its line' : ''}
          </div>
        </div>
      )}
      <p className="hint">Hover a token to see where it came from. Switch to “after preprocessing” to see macros expanded and #includes pulled in.</p>
    </div>
  );
}
