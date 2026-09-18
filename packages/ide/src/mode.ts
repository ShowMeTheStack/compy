import { LabPreset, LAB_PRESETS, LabConfig } from '@compy/lab';

/** Which product is open: the C89 compiler or the language lab. */
export type Mode = 'c89' | 'lab';

const MODE_KEY = 'compy.mode.v1';
const LAB_KEY = 'compy.lab.v1';

export function loadMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === 'lab') return 'lab';
  } catch {
    /* ignore */
  }
  return 'c89';
}
export function saveMode(m: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* ignore */
  }
}

export interface LabProject {
  lex: string;
  grammar: string;
  input: string;
  config: LabConfig;
  /** Which document the editor shows. */
  active: 'lex' | 'grammar' | 'input';
}

export function presetToProject(p: LabPreset): LabProject {
  return { lex: p.lex, grammar: p.grammar, input: p.input, config: { lexerMode: p.lexerMode, stage: p.stage, parser: p.parser, skipWhitespace: true }, active: p.stage === 'lexer' ? 'lex' : 'grammar' };
}

export function loadLabProject(): LabProject {
  try {
    const raw = localStorage.getItem(LAB_KEY);
    if (raw) {
      const p = JSON.parse(raw) as LabProject;
      if (p.config && typeof p.input === 'string') return p;
    }
  } catch {
    /* ignore */
  }
  return presetToProject(LAB_PRESETS[0]!);
}
export function saveLabProject(p: LabProject): void {
  try {
    localStorage.setItem(LAB_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
