import { describe, it, expect } from 'vitest';
import { CORPUS } from '@compy/testgen';
import { EXTRA_PROGRAMS } from '../extra-programs';
import { lowerSource, runModule, runTreeWalker } from '../harness';
import { optimize, PASSES, PassId } from './index';
import { fmtModule, instrCount } from '../ir';

const ALL = [...CORPUS, ...EXTRA_PROGRAMS];

/**
 * The optimizer must never change what a program prints. Every program is
 * run after the full pipeline and after each pass alone; the output must
 * match the (clang-verified) tree-walker.
 */
describe('optimizer preserves program behaviour (full pipeline)', () => {
  for (const prog of ALL) {
    it(prog.name, () => {
      const expected = runTreeWalker(prog.source, prog.stdin ?? '');
      const { module, errors } = lowerSource(prog.source);
      expect(errors).toEqual([]);
      const { module: opt } = optimize(module);
      const got = runModule(opt, { 'main.c': prog.source }, prog.stdin ?? '');
      expect(got.stdout).toBe(expected.stdout);
      expect(got.exit).toBe(expected.exit);
    });
  }
});

describe('each pass alone preserves behaviour', () => {
  for (const pass of PASSES) {
    it(pass.id, () => {
      for (const prog of ALL) {
        const expected = runTreeWalker(prog.source, prog.stdin ?? '');
        const { module } = lowerSource(prog.source);
        const enabled: PassId[] = pass.id === 'simplifycfg' ? ['simplifycfg'] : ['simplifycfg', pass.id];
        const { module: opt } = optimize(module, enabled);
        const got = runModule(opt, { 'main.c': prog.source }, prog.stdin ?? '');
        expect(got.stdout, `${pass.id} on ${prog.name}`).toBe(expected.stdout);
        expect(got.exit, `${pass.id} on ${prog.name}`).toBe(expected.exit);
      }
    });
  }
});

describe('what the passes do', () => {
  it('mem2reg removes every alloca of a scalar local and inserts phis at merges', () => {
    const { module } = lowerSource(`int f(int n){ int s = 0, i; for (i = 0; i < n; i++) s += i; return s; } int main(void){ return f(5); }`);
    const { module: opt, records } = optimize(module, ['simplifycfg', 'mem2reg']);
    const f = fmtModule(opt);
    expect(f).not.toContain('alloca');
    expect(f).toContain('phi i32');
    expect(records.some((r) => r.pass === 'mem2reg' && r.fn === 'f')).toBe(true);
  });
  it('constant folding computes 2*21 at compile time', () => {
    const { module } = lowerSource(`int main(void){ int a = 2 * 21; return a + 0 * 7; }`);
    const { module: opt } = optimize(module, ['simplifycfg', 'mem2reg', 'constfold', 'algebra', 'dce']);
    const text = fmtModule(opt);
    expect(text).toContain('ret i32 42');
    expect(text).not.toContain('mul');
  });
  it('strength reduction turns x*8 into x<<3 and unsigned x/4 into x>>2', () => {
    const { module } = lowerSource(`unsigned f(unsigned x){ return x * 8 + x / 4 + x % 16; } int main(void){ return f(3); }`);
    const { module: opt } = optimize(module, ['simplifycfg', 'mem2reg', 'algebra']);
    const text = fmtModule(opt);
    expect(text).toContain('shl i32');
    expect(text).toContain('lshr i32');
    expect(text).toContain('and i32');
    expect(text).not.toContain('udiv');
  });
  it('dead code elimination removes an unused computation', () => {
    const { module } = lowerSource(`int main(void){ int unused = 3 * 4; return 0; }`);
    const { module: opt } = optimize(module, ['simplifycfg', 'mem2reg', 'dce']);
    expect(instrCount(opt.functions[0]!)).toBe(1); // just `ret`
  });
  it('CSE reuses a repeated expression', () => {
    const { module } = lowerSource(`int f(int a, int b){ return (a * b) + (a * b); } int main(void){ return f(2,3); }`);
    const { module: opt } = optimize(module, ['simplifycfg', 'mem2reg', 'cse']);
    const f = fmtModule(opt).split('define')[1]!;
    expect((f.match(/= mul i32/g) ?? []).length).toBe(1);
  });
  it('LICM hoists an invariant multiply out of the loop into a preheader', () => {
    const { module } = lowerSource(`int f(int n, int k){ int i, s = 0; for (i = 0; i < n; i++) s += k * 7; return s; } int main(void){ return f(3, 2); }`);
    const { module: opt, records } = optimize(module, ['simplifycfg', 'mem2reg', 'licm']);
    const text = fmtModule(opt);
    expect(records.some((r) => r.pass === 'licm')).toBe(true);
    // The multiply must appear before the loop header's block in textual order.
    const mulAt = text.indexOf('mul i32');
    const condAt = text.indexOf('for.cond:');
    expect(mulAt).toBeGreaterThan(0);
    expect(mulAt).toBeLessThan(condAt);
  });
  it('inlining replaces a call with the callee body', () => {
    const { module } = lowerSource(`static int sq(int x){ return x * x; } int main(void){ return sq(6) + sq(7); }`);
    const { module: opt, records } = optimize(module, ['simplifycfg', 'mem2reg', 'inline', 'constfold', 'dce']);
    const main = opt.functions.find((f) => f.name === 'main')!;
    const text = fmtModule({ ...opt, functions: [main] });
    expect(text).not.toContain('call');
    expect(text).toContain('ret i32 85');
    expect(records.some((r) => r.pass === 'inline')).toBe(true);
  });
  it('simplifycfg folds a constant branch and removes the dead block', () => {
    const { module } = lowerSource(`int main(void){ if (1) return 1; else return 2; }`);
    const { module: opt } = optimize(module, ['simplifycfg', 'mem2reg', 'constfold']);
    const text = fmtModule(opt);
    expect(text).not.toContain('if.else');
    expect(text).toContain('ret i32 1');
  });
  it('records before/after text for the UI', () => {
    const { module } = lowerSource(`int main(void){ int a = 1 + 2; return a; }`);
    const { records } = optimize(module);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.before).not.toBe(r.after);
      expect(r.instrsAfter).toBeLessThanOrEqual(r.instrsBefore + 5);
    }
  });
});
