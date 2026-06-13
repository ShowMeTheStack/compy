import { useEffect, useRef } from 'react';
import { EditorState, StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  gutter,
  GutterMarker,
  Decoration,
  DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { ghostText } from './ghost';

export interface EditorDiagnostic {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  severity: 'error' | 'warning';
  message: string;
}

interface EditorProps {
  doc: string;
  onChange: (doc: string) => void;
  breakpoints: Set<number>;
  onToggleBreakpoint: (line: number) => void;
  diagnostics: EditorDiagnostic[];
  currentLine: number | null;
  onGotoDef: (line: number, col: number) => void;
  /** Inline AI completion provider (empty string = no ghost). */
  ghostProvider?: (before: string, after: string) => Promise<string>;
}

// -- a compact C stream tokenizer for highlighting ---------------------------

const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extern', 'float', 'for', 'goto', 'if', 'int', 'long', 'register', 'return', 'short', 'signed',
  'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile',
  'while', 'inline', '_Bool', 'restrict',
]);

const cLanguage = StreamLanguage.define<{ inComment: boolean }>({
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.match(/.*?\*\//)) state.inComment = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.inComment = true;
      return 'comment';
    }
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^#\s*\w+/)) return 'meta';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^\d+\.?\d*(?:[eE][+-]?\d+)?[fFuUlL]*/)) return 'number';
    if (stream.match(/^0[xX][0-9a-fA-F]+[uUlL]*/)) return 'number';
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const w = stream.current();
      if (KEYWORDS.has(w)) return 'keyword';
      return null;
    }
    stream.next();
    return null;
  },
  tokenTable: {},
});

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: '#569cd6' },
  { tag: t.comment, color: '#6a9955', fontStyle: 'italic' },
  { tag: t.string, color: '#ce9178' },
  { tag: t.number, color: '#b5cea8' },
  { tag: t.meta, color: '#c586c0' },
]);

// -- breakpoints -------------------------------------------------------------

const setBreakpointsEffect = StateEffect.define<Set<number>>();
const breakpointField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBreakpointsEffect)) return e.value;
    return value;
  },
});

class BreakpointMarker extends GutterMarker {
  override toDOM() {
    const span = document.createElement('span');
    span.textContent = '●';
    span.className = 'cm-breakpoint';
    return span;
  }
}
const breakpointMarker = new BreakpointMarker();

// -- diagnostics (underline) & current line ----------------------------------

const setDiagnosticsEffect = StateEffect.define<EditorDiagnostic[]>();
const diagnosticsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDiagnosticsEffect)) {
        const builder = new RangeSetBuilder<Decoration>();
        const doc = tr.state.doc;
        for (const d of e.value.slice().sort((a, b) => a.line - b.line || a.col - b.col)) {
          if (d.line < 1 || d.line > doc.lines) continue;
          const lineInfo = doc.line(d.line);
          const from = Math.min(lineInfo.from + d.col - 1, lineInfo.to);
          const to = Math.min(Math.max(from + 1, d.endLine === d.line ? lineInfo.from + d.endCol - 1 : lineInfo.to), lineInfo.to);
          builder.add(from, Math.max(to, from + 1), Decoration.mark({ class: `cm-diag-${d.severity}`, attributes: { title: d.message } }));
        }
        return builder.finish();
      }
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const setCurrentLineEffect = StateEffect.define<number | null>();
const currentLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCurrentLineEffect)) {
        if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) return Decoration.none;
        const line = tr.state.doc.line(e.value);
        return Decoration.set([Decoration.line({ class: 'cm-current-line' }).range(line.from)]);
      }
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, Menlo, Consolas, monospace' },
  '.cm-breakpoint': { color: '#e51400', cursor: 'pointer' },
  '.cm-breakpoint-gutter': { width: '1.2em', cursor: 'pointer' },
  '.cm-diag-error': { textDecoration: 'underline wavy #e51400' },
  '.cm-diag-warning': { textDecoration: 'underline wavy #cca700' },
  '.cm-current-line': { backgroundColor: 'rgba(255, 221, 87, 0.18)' },
  '.cm-ghost': { color: '#6a6a6a', fontStyle: 'italic' },
});

export function Editor({ doc, onChange, breakpoints, onToggleBreakpoint, diagnostics, currentLine, onGotoDef, ghostProvider }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cbs = useRef({ onChange, onToggleBreakpoint, onGotoDef, ghostProvider });
  cbs.current = { onChange, onToggleBreakpoint, onGotoDef, ghostProvider };

  // Create the editor once.
  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        cLanguage,
        syntaxHighlighting(highlightStyle),
        breakpointField,
        diagnosticsField,
        currentLineField,
        gutter({
          class: 'cm-breakpoint-gutter',
          lineMarker: (v, block) => {
            const line = v.state.doc.lineAt(block.from).number;
            return v.state.field(breakpointField).has(line) ? breakpointMarker : null;
          },
          initialSpacer: () => breakpointMarker,
          domEventHandlers: {
            mousedown: (v, block) => {
              const line = v.state.doc.lineAt(block.from).number;
              cbs.current.onToggleBreakpoint(line);
              return true;
            },
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cbs.current.onChange(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          mousedown: (event, v) => {
            if (!(event.metaKey || event.ctrlKey)) return false;
            const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            const line = v.state.doc.lineAt(pos);
            cbs.current.onGotoDef(line.number, pos - line.from + 1);
            return true;
          },
        }),
        ghostText((before, after) => cbs.current.ghostProvider?.(before, after) ?? Promise.resolve('')),
        editorTheme,
        EditorView.theme({}, { dark: true }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external doc changes (file switch) into the editor.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== doc) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc } });
    }
  }, [doc]);

  useEffect(() => {
    view.current?.dispatch({ effects: setBreakpointsEffect.of(new Set(breakpoints)) });
  }, [breakpoints]);
  useEffect(() => {
    view.current?.dispatch({ effects: setDiagnosticsEffect.of(diagnostics) });
  }, [diagnostics]);
  useEffect(() => {
    view.current?.dispatch({ effects: setCurrentLineEffect.of(currentLine) });
  }, [currentLine]);

  return <div className="editor-host" ref={host} data-testid="editor" />;
}
