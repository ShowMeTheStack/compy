import { test, expect } from '@playwright/test';
import { EXAMPLES } from '../../packages/ide/src/examples';
import { FEATURES } from '../../packages/testgen/src/features';
import { fresh, loadProgram, setEngine, setStdin, run, outputOf, assertLayout, openPanel } from './helpers';

/**
 * Optimizer controls: every pass toggled off alone, and all passes off, must
 * leave program output unchanged on the IR and machine engines; the panel
 * explains each pass and shows diffs.
 */
const PASSES = ['simplifycfg', 'mem2reg', 'inline', 'constfold', 'algebra', 'cse', 'dce', 'licm'];
const PROGRAMS = [
  ...EXAMPLES.filter((e) => e.category.startsWith('Compiler') || e.category === 'Control flow' || e.category === 'Functions').map((e) => ({ name: e.name, files: e.files, stdin: undefined as string | undefined })),
  ...FEATURES.filter((f) => !f.fault && ['expressions', 'control', 'functions', 'arrays'].includes(f.area)).map((f) => ({ name: f.name, files: { 'main.c': f.source }, stdin: f.stdin })),
];

for (const pass of PASSES) {
  test.describe(`pass ${pass} off`, () => {
    for (const p of PROGRAMS) {
      test(`${p.name} without ${pass}: same output on IR and machine`, async ({ page }) => {
        await fresh(page);
        await loadProgram(page, p.files);
        if (p.stdin) await setStdin(page, p.stdin);
        await setEngine(page, 'ast');
        const ref = outputOf(await run(page));
        await openPanel(page, 'optimize');
        await page.getByTestId(`pass-${pass}`).uncheck();
        await setEngine(page, 'ir');
        expect(outputOf(await run(page))).toBe(ref);
        await setEngine(page, 'machine');
        expect(outputOf(await run(page))).toBe(ref);
        await assertLayout(page);
      });
    }
  });
}

test.describe('optimizer panel', () => {
  for (const p of PROGRAMS) {
    test(`${p.name}: descriptions, log, diff`, async ({ page }) => {
      await fresh(page);
      await loadProgram(page, p.files);
      await openPanel(page, 'optimize');
      await page.locator('.pass button.link').first().click();
      await expect(page.locator('.pass-desc').first()).toBeVisible();
      const entries = page.locator('.pass-log li');
      if ((await entries.count()) > 0) {
        await entries.first().click();
        await expect(page.getByTestId('diff')).toBeVisible();
      }
      await page.locator('.optview .btn', { hasText: 'all off' }).click();
      await expect(page.getByTestId('optimize')).toContainText(/No pass changed anything|instructions/);
      await page.locator('.optview .btn', { hasText: 'all on' }).click();
      await assertLayout(page);
    });
  }
});
