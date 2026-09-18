import { useState } from 'react';
import { LabPreset, LAB_PRESETS } from '@compy/lab';
import { LAB_LESSONS, LabLesson } from '../labLessons';

/** The automata & parsing course inside the lab's Learn tab. */
interface Props {
  onLoad: (preset: LabPreset) => void;
  onOpenPanel: (p: 'automata' | 'tokens' | 'analysis' | 'parse' | 'tree') => void;
}

const SECTION: Record<LabLesson['section'], string> = { automata: 'Automata & lexing', grammars: 'Grammars & parsing' };

export function LabLearnView({ onLoad, onOpenPanel }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  const lesson = LAB_LESSONS.find((l) => l.id === sel) ?? null;
  if (lesson) {
    const preset = LAB_PRESETS.find((p) => p.name === lesson.preset);
    return (
      <div className="learn" data-testid="lab-learn">
        <button className="link" onClick={() => setSel(null)}>
          ← all lessons
        </button>
        <h2>{lesson.title}</h2>
        <p className="lesson-summary">{lesson.summary}</p>
        {lesson.body.map((p, k) => (
          <p key={k} className="lesson-p" dangerouslySetInnerHTML={{ __html: inline(p) }} />
        ))}
        <div className="panel-toolbar">
          {preset && (
            <button
              className="btn run"
              onClick={() => {
                onLoad(preset);
                onOpenPanel(lesson.panel);
              }}
              data-testid="lab-lesson-load"
            >
              Load “{preset.name}” and open {lesson.panel}
            </button>
          )}
        </div>
        <h3>Try this</h3>
        <ol className="try-this">
          {lesson.tryThis.map((t, k) => (
            <li key={k} dangerouslySetInnerHTML={{ __html: inline(t) }} />
          ))}
        </ol>
      </div>
    );
  }
  return (
    <div className="learn" data-testid="lab-learn">
      <p className="hint">Automata theory and parsing in {LAB_LESSONS.length} short lessons. Each loads a preset and tells you what to look for.</p>
      {(['automata', 'grammars'] as const).map((sec) => (
        <section key={sec}>
          <h3>{SECTION[sec]}</h3>
          <ul className="lesson-list">
            {LAB_LESSONS.filter((l) => l.section === sec).map((l) => (
              <li key={l.id}>
                <button className="link" onClick={() => setSel(l.id)} data-testid={`lab-lesson-${l.id}`}>
                  {l.title}
                </button>
                <span className="dim"> — {l.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function inline(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}
