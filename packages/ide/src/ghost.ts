import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';

/**
 * Inline "ghost text" completion — dimmed shadow code shown after the cursor
 * that the user accepts with Tab. Driven by an async suggestion provider (the
 * AI engine); when it returns nothing, no ghost shows. Only active at end of a
 * non-empty line.
 */

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  override toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = 'cm-ghost';
    s.setAttribute('data-testid', 'cm-ghost');
    s.textContent = this.text;
    return s;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const setGhost = StateEffect.define<string | null>();

const ghostField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
});

function currentGhost(view: EditorView): string | null {
  return view.state.field(ghostField, false) ?? null;
}

function acceptGhost(view: EditorView): boolean {
  const text = currentGhost(view);
  if (!text) return false;
  const head = view.state.selection.main.head;
  view.dispatch({ changes: { from: head, insert: text }, selection: { anchor: head + text.length }, effects: setGhost.of(null) });
  return true;
}

const ghostDeco = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

function build(view: EditorView): DecorationSet {
  const text = view.state.field(ghostField, false);
  if (!text) return Decoration.none;
  const head = view.state.selection.main.head;
  return Decoration.set([Decoration.widget({ widget: new GhostWidget(text), side: 1 }).range(head)]);
}

export function ghostText(getSuggestion: (before: string, after: string) => Promise<string>): Extension {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  const fetcher = EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const view = u.view;
    if (timer) clearTimeout(timer);
    const mySeq = ++seq;
    timer = setTimeout(() => {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      if (head !== line.to || head === 0) {
        if (currentGhost(view)) view.dispatch({ effects: setGhost.of(null) });
        return;
      }
      const before = view.state.sliceDoc(Math.max(0, head - 800), head);
      const after = view.state.sliceDoc(head, Math.min(view.state.doc.length, head + 200));
      const docLen = view.state.doc.length;
      void getSuggestion(before, after)
        .catch(() => '')
        .then((text) => {
          if (mySeq !== seq) return;
          if (view.state.selection.main.head !== head || view.state.doc.length !== docLen) return;
          const next = (text || '').split('\n')[0] || '';
          if (!next && !currentGhost(view)) return;
          view.dispatch({ effects: setGhost.of(next || null) });
        });
    }, 500);
  });

  return [ghostField, ghostDeco, fetcher, Prec.highest(keymap.of([{ key: 'Tab', run: acceptGhost }]))];
}
