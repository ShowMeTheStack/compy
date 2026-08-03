import { useMemo, useState } from 'react';
import { LESSONS, Lesson, Phase } from './lessons';

/**
 * The course: short lessons per compiler phase, each with a program the
 * student loads into the editor and concrete things to try in the panels.
 */
interface Props {
  onLoad: (code: string, name: string) => void;
  onOpenPhase: (phase: Phase) => void;
}

const PHASE_LABEL: Record<Phase, string> = {
  lex: 'Lexing',
  preprocess: 'Preprocessing',
  parse: 'Parsing',
  sema: 'Semantic analysis',
  ir: 'Intermediate representation',
  opt: 'Optimization',
  codegen: 'Code generation',
  run: 'Running',
};

export function LearnView({ onLoad, onOpenPhase }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  const groups = useMemo(() => {
    const g = new Map<Phase, Lesson[]>();
    for (const l of LESSONS) g.set(l.phase, [...(g.get(l.phase) ?? []), l]);
    return [...g.entries()];
  }, []);
  const lesson = LESSONS.find((l) => l.id === sel) ?? null;
  if (lesson) {
    return (
      <div className="learn" data-testid="learn">
        <button className="link" onClick={() => setSel(null)}>
          ← all lessons
        </button>
        <h2>{lesson.title}</h2>
        <p className="lesson-summary">{lesson.summary}</p>
        {lesson.body.map((p, k) => (
          <p key={k} className="lesson-p" dangerouslySetInnerHTML={{ __html: inline(p) }} />
        ))}
        <div className="panel-toolbar">
          <button className="btn run" onClick={() => onLoad(lesson.example, lesson.id + '.c')} data-testid="lesson-load">
            Load the example
          </button>
          <button className="btn" onClick={() => onOpenPhase(lesson.phase)}>
            Open the {PHASE_LABEL[lesson.phase]} panel
          </button>
        </div>
        <pre className="lesson-code">{lesson.example}</pre>
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
    <div className="learn" data-testid="learn">
      <p className="hint">A compilers course in {LESSONS.length} short lessons. Each one loads a program and tells you what to look for.</p>
      {groups.map(([phase, ls]) => (
        <section key={phase}>
          <h3>{PHASE_LABEL[phase]}</h3>
          <ul className="lesson-list">
            {ls.map((l) => (
              <li key={l.id}>
                <button className="link" onClick={() => setSel(l.id)} data-testid={`lesson-${l.id}`}>
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

/** Minimal inline markup: **bold** and `code`, with HTML escaped first. */
function inline(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}
