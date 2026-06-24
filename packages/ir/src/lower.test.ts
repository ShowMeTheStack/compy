import { describe, it, expect } from 'vitest';
import { CORPUS } from '@compy/testgen';
import { runTreeWalker, runIrSource, lowerSource } from './harness';
import { fmtModule } from './ir';
import { EXTRA_PROGRAMS } from './extra-programs';

/**
 * Lowering is checked differentially: every corpus program must produce the
 * same stdout and exit code on the IR interpreter as on the tree-walking
 * interpreter (which is itself checked against clang).
 */
describe('AST → IR lowering (differential vs the tree-walker)', () => {
  for (const prog of CORPUS) {
    it(prog.name, () => {
      const a = runTreeWalker(prog.source, prog.stdin ?? '');
      const b = runIrSource(prog.source, prog.stdin ?? '');
      expect(b.stdout).toBe(a.stdout);
      expect(b.exit).toBe(a.exit);
    });
  }
  for (const prog of EXTRA_PROGRAMS) {
    it(prog.name, () => {
      const a = runTreeWalker(prog.source, prog.stdin ?? '');
      const b = runIrSource(prog.source, prog.stdin ?? '');
      expect(b.stderr).toBe(a.stderr);
      expect(b.stdout).toBe(a.stdout);
      expect(b.exit).toBe(a.exit);
    });
  }
});

describe('IR shape', () => {
  it('locals become allocas with loads and stores; params are spilled', () => {
    const { module, errors } = lowerSource(`int add(int a, int b){ int s = a + b; return s; }\nint main(void){ return add(1,2); }`);
    expect(errors).toEqual([]);
    const text = fmtModule(module);
    expect(text).toContain('alloca int ; a');
    expect(text).toContain('alloca int ; s');
    expect(text).toMatch(/store i32 %a\.\d+, %a\.addr\.\d+/);
    expect(text).toContain('= add i32');
    expect(text).toContain('ret i32');
  });
  it('control flow gets labelled blocks', () => {
    const { module } = lowerSource(`int main(void){ int i, s = 0; for (i = 0; i < 10; i++) { if (i % 2) continue; s += i; } return s; }`);
    const text = fmtModule(module);
    for (const b of ['for.cond:', 'for.body:', 'for.step:', 'for.end:', 'if.then:']) expect(text).toContain(b);
  });
  it('string literals and globals are module-level', () => {
    const { module } = lowerSource(`int g = 5; const char *s = "hi"; int main(void){ return g; }`);
    const text = fmtModule(module);
    expect(text).toContain('@.str0 = "hi"');
    expect(text).toContain('@g = global int');
  });
});
