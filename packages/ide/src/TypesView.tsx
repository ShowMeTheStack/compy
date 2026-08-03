import { useMemo } from 'react';
import * as A from '@compy/cc';
import { SemaResult, SymbolInfo, CType, formatType, sizeof, alignof, Diagnostic } from '@compy/cc';
import { EditorRange } from './Editor';

/**
 * Phase 7 (semantic analysis) panel: the symbol table with every symbol's
 * resolved type, size and alignment; struct layouts with padding made
 * visible; and the diagnostics the analyzer raised.
 */
interface Props {
  unit: A.TranslationUnit;
  sema: SemaResult;
  diagnostics: Diagnostic[];
  activePath: string;
  onHover: (r: EditorRange | null) => void;
}

function rangeOf(span: A.Span): EditorRange {
  return { line: span.start.line, col: span.start.col, endLine: span.end.line, endCol: span.end.col };
}

export function TypesView({ sema, diagnostics, activePath, onHover }: Props) {
  const symbols = useMemo(() => {
    const seen = new Set<number>();
    const out: SymbolInfo[] = [];
    for (const s of [...sema.globals, ...sema.symOf.values()]) {
      if (seen.has(s.id) || s.declSpan.start.file !== activePath) continue;
      seen.add(s.id);
      out.push(s);
    }
    return out.sort((a, b) => a.declSpan.start.line - b.declSpan.start.line || a.id - b.id);
  }, [sema, activePath]);

  const structs = useMemo(() => {
    const found = new Map<number, CType>();
    const visit = (t: CType) => {
      if ((t.kind === 'struct' || t.kind === 'union') && t.complete && !found.has(t.id)) {
        found.set(t.id, t);
        for (const f of t.fields) visit(f.type);
      } else if (t.kind === 'pointer') visit(t.to);
      else if (t.kind === 'array') visit(t.of);
      else if (t.kind === 'function') {
        visit(t.ret);
        t.params.forEach(visit);
      }
    };
    for (const s of symbols) visit(s.type);
    for (const t of sema.typeOf.values()) visit(t);
    return [...found.values()];
  }, [symbols, sema]);

  const errors = diagnostics.filter((d) => d.span.start.file === activePath);
  return (
    <div className="types" data-testid="types">
      <section>
        <h3>Symbol table</h3>
        {symbols.length === 0 ? (
          <p className="hint">No symbols declared in this file.</p>
        ) : (
          <table className="mem-table" onMouseLeave={() => onHover(null)}>
            <thead>
              <tr>
                <th>name</th>
                <th>kind</th>
                <th>type</th>
                <th>size</th>
                <th>align</th>
                <th>linkage</th>
                <th>line</th>
              </tr>
            </thead>
            <tbody>
              {symbols.map((s) => (
                <tr key={s.id} onMouseEnter={() => onHover(rangeOf(s.declSpan))}>
                  <td className="mono">{s.name}</td>
                  <td>{s.kind}{s.enumValue !== undefined ? ` = ${s.enumValue}` : ''}</td>
                  <td className="type">{formatType(s.type)}</td>
                  <td className="mono">{s.type.kind === 'function' ? '—' : s.type.kind === 'array' && s.type.length === null ? '?' : sizeof(s.type)}</td>
                  <td className="mono">{s.type.kind === 'function' ? '—' : alignof(s.type)}</td>
                  <td className="dim">{s.linkage}{s.storage ? ` (${s.storage})` : ''}</td>
                  <td className="mono dim">{s.declSpan.start.line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {structs.length > 0 && (
        <section>
          <h3>Struct &amp; union layouts (ILP32)</h3>
          {structs.map((t) => (t.kind === 'struct' || t.kind === 'union') && <StructLayout key={t.id} t={t} />)}
        </section>
      )}

      <section>
        <h3>Diagnostics</h3>
        {errors.length === 0 ? (
          <p className="hint">The analyzer is happy. ✓</p>
        ) : (
          <ul className="problems">
            {errors.map((d, i) => (
              <li key={i} className={d.severity} onMouseEnter={() => onHover(rangeOf(d.span))}>
                <span className="sev">{d.severity}</span>
                <span className="msg">{d.message}</span>
                <span className="mono loc">:{d.span.start.line}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="hint">Sizes follow the ILP32 model (int/long/pointer = 4 bytes). Padding is inserted so every field sits at a multiple of its alignment.</p>
    </div>
  );
}

function StructLayout({ t }: { t: Extract<CType, { kind: 'struct' | 'union' }> }) {
  const cells: { label: string; from: number; size: number; pad: boolean }[] = [];
  if (t.kind === 'struct') {
    let at = 0;
    for (const f of t.fields) {
      if (f.offset > at) cells.push({ label: 'pad', from: at, size: f.offset - at, pad: true });
      cells.push({ label: f.name, from: f.offset, size: sizeof(f.type), pad: false });
      at = f.offset + sizeof(f.type);
    }
    if (t.size > at) cells.push({ label: 'pad', from: at, size: t.size - at, pad: true });
  }
  return (
    <div className="struct-layout">
      <div className="struct-title">
        <span className="type">{formatType(t)}</span> — {t.size} bytes, align {t.align}
      </div>
      {t.kind === 'struct' ? (
        <div className="struct-bar">
          {cells.map((c, k) => (
            <div key={k} className={`struct-cell ${c.pad ? 'pad' : ''}`} style={{ flex: c.size }} title={`${c.label}: offset ${c.from}, ${c.size} byte(s)`}>
              <span>{c.label}</span>
              <small>@{c.from}</small>
            </div>
          ))}
        </div>
      ) : (
        <div className="struct-bar">
          {t.fields.map((f) => (
            <div key={f.name} className="struct-cell" style={{ flex: 1 }} title={`${f.name}: all fields share offset 0`}>
              <span>{f.name}</span>
              <small>{sizeof(f.type)}B</small>
            </div>
          ))}
        </div>
      )}
      <table className="mem-table">
        <tbody>
          {t.fields.map((f) => (
            <tr key={f.name}>
              <td className="mono">{f.name}</td>
              <td className="type">{formatType(f.type)}</td>
              <td className="mono">offset {f.offset}</td>
              <td className="mono">{sizeof(f.type)} B</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
