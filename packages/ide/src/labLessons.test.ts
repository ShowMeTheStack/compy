import { describe, it, expect } from 'vitest';
import { LAB_LESSONS } from './labLessons';
import { LAB_PRESETS, runLab } from '@compy/lab';

describe('lab lessons', () => {
  it('have unique ids and reference existing presets', () => {
    const ids = new Set(LAB_LESSONS.map((l) => l.id));
    expect(ids.size).toBe(LAB_LESSONS.length);
    for (const l of LAB_LESSONS) {
      expect(LAB_PRESETS.some((p) => p.name === l.preset), `${l.id} → ${l.preset}`).toBe(true);
      expect(l.body.length).toBeGreaterThanOrEqual(2);
      expect(l.tryThis.length).toBeGreaterThanOrEqual(2);
    }
  });
  it('every lesson preset runs without problems', () => {
    for (const l of LAB_LESSONS) {
      const p = LAB_PRESETS.find((x) => x.name === l.preset)!;
      const r = runLab({ lexerMode: p.lexerMode, stage: p.stage, parser: p.parser }, p.lex, p.grammar, p.input);
      const fatal = r.problems.filter((x) => x.phase !== 'parser');
      expect(fatal, l.id).toEqual([]);
    }
  });
});
