import { test, expect } from '@playwright/test';
import { EXAMPLES } from '../../packages/ide/src/examples';
import { FEATURES, FEATURE_EXTRA_FILES } from '../../packages/testgen/src/features';
import { CORPUS } from '../../packages/testgen/src/corpus';
import { EXTRA_PROGRAMS } from '../../packages/ir/src/extra-programs';
import { fresh, loadProgram, setEngine, setStdin, run, outputOf, assertLayout, isBugDemo, Engine } from './helpers';

/**
 * Every program × every engine: runs, produces output, exits, and the three
 * engines agree. Bug demos must raise their fault. Expected outputs are
 * asserted where known.
 */
const ENGINES: Engine[] = ['ast', 'ir', 'machine'];

interface Prog {
  name: string;
  files: Record<string, string>;
  stdin?: string;
  expected?: string;
  fault?: string;
  bug: boolean;
}
const PROGRAMS: Prog[] = [
  ...EXAMPLES.map((e) => ({ name: `example: ${e.name}`, files: e.files, bug: isBugDemo(e.name, e.category) })),
  ...FEATURES.map((f) => ({ name: `feature: ${f.name}`, files: { 'main.c': f.source, ...(FEATURE_EXTRA_FILES[f.name] ?? {}) }, stdin: f.stdin, expected: f.fault ? undefined : f.expected, fault: f.fault, bug: !!f.fault })),
  ...CORPUS.map((c) => ({ name: `corpus: ${c.name}`, files: { 'main.c': c.source }, stdin: c.stdin, bug: false })),
  ...EXTRA_PROGRAMS.map((c) => ({ name: `stress: ${c.name}`, files: { 'main.c': c.source }, stdin: c.stdin, bug: /uaf/.test(c.name) })),
];

for (const engine of ENGINES) {
  test.describe(`run on the ${engine} engine`, () => {
    for (const p of PROGRAMS) {
      test(`${p.name} [${engine}]`, async ({ page }) => {
        await fresh(page);
        await loadProgram(page, p.files);
        if (p.stdin) await setStdin(page, p.stdin);
        await setEngine(page, engine);
        const out = await run(page);
        if (p.fault) {
          if (p.fault === 'leak') await expect(page.locator('.fault-banner.leak')).toBeVisible();
          else await expect(page.locator('.fault-banner').first()).toContainText(p.fault);
        } else if (!p.bug) {
          expect(out).not.toContain('Runtime fault');
          expect(out).not.toContain('Runtime error');
        }
        if (p.expected !== undefined) expect(outputOf(out)).toBe(p.expected.replace(/\n+$/, ''));
        await assertLayout(page);
      });
    }
  });
}

test.describe('the three engines agree', () => {
  for (const p of PROGRAMS) {
    test(`${p.name} [ast = ir = machine]`, async ({ page }) => {
      await fresh(page);
      await loadProgram(page, p.files);
      if (p.stdin) await setStdin(page, p.stdin);
      const outs: string[] = [];
      for (const e of ENGINES) {
        await setEngine(page, e);
        outs.push(outputOf(await run(page)).replace(/\n?Runtime (fault|error):.*$/s, ''));
      }
      expect(outs[1], 'ir vs ast').toBe(outs[0]);
      expect(outs[2], 'machine vs ast').toBe(outs[0]);
    });
  }
});
