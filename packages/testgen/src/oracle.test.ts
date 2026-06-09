import { describe, it, expect } from 'vitest';
import { differential, hasClang } from './oracle';
import { CORPUS } from './corpus';

// The differential suite needs the real system compiler. When clang is absent
// (e.g. minimal CI images) the suite is skipped rather than failing.
const clang = hasClang();

describe.skipIf(!clang)('interpreter vs. clang (differential oracle)', () => {
  for (const prog of CORPUS) {
    it(`matches clang: ${prog.name}`, () => {
      const r = differential(prog.source, prog.stdin ?? '');
      if (!r.match) {
        throw new Error(
          `${prog.name}: ${r.reason}\n--- clang (exit ${r.clang.exit}) ---\n${r.clang.stdout}\n--- cide (exit ${r.cide.exit}) ---\n${r.cide.stdout}`,
        );
      }
      expect(r.match).toBe(true);
    });
  }
});

describe('oracle availability', () => {
  it('reports whether clang is present', () => {
    expect(typeof clang).toBe('boolean');
  });
});
