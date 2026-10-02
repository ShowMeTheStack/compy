import { describe, it, expect } from 'vitest';
import { FEATURES, FEATURE_EXTRA_FILES } from './features';
import { compileAndRun } from '@compy/libc';
import { hasClang, runWithClang } from './oracle';

describe('C89 feature programs have the expected output on the tree-walker', () => {
  for (const f of FEATURES) {
    it(f.name, () => {
      const files = { 'main.c': f.source, ...(FEATURE_EXTRA_FILES[f.name] ?? {}) };
      const r = compileAndRun({ files, stdin: f.stdin ?? '', argv: ['prog'] });
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      if (f.fault) {
        const kinds = [...(r.result?.faults ?? []).map((x) => x.kind), ...(r.result?.fatal ? [r.result.fatal.kind] : []), ...(r.result?.leaks.length ? ['leak'] : [])];
        expect(kinds, f.name).toContain(f.fault);
      } else {
        expect(r.stdout).toBe(f.expected);
        expect(r.stderr).toBe('');
      }
    });
  }
});

describe.skipIf(!hasClang())('C89 feature programs match clang', () => {
  for (const f of FEATURES.filter((x) => !x.fault && !x.noClang && !FEATURE_EXTRA_FILES[x.name])) {
    it(f.name, () => {
      const c = runWithClang(f.source, f.stdin ?? '');
      expect(c.stdout).toBe(f.expected);
    });
  }
});
