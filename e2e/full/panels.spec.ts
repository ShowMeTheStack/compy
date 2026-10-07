import { test, expect } from '@playwright/test';
import { EXAMPLES } from '../../packages/ide/src/examples';
import { FEATURES, FEATURE_EXTRA_FILES } from '../../packages/testgen/src/features';
import { fresh, loadProgram, openPanel, assertLayout, run } from './helpers';

/**
 * Every program × every phase panel: the panel renders the program's own
 * data (not a stale one), hover links to the source work, nothing overlaps.
 */
const PROGRAMS = [
  ...EXAMPLES.map((e) => ({ name: `example: ${e.name}`, files: e.files })),
  ...FEATURES.filter((f) => !f.fault).map((f) => ({ name: `feature: ${f.name}`, files: { 'main.c': f.source, ...(FEATURE_EXTRA_FILES[f.name] ?? {}) } })),
];

const PANELS = ['tokens', 'preprocess', 'ast', 'types', 'ir', 'optimize', 'asm'] as const;

for (const panel of PANELS) {
  test.describe(`${panel} panel`, () => {
    for (const p of PROGRAMS) {
      test(`${p.name} → ${panel}`, async ({ page }) => {
        await fresh(page);
        await loadProgram(page, p.files);
        await openPanel(page, panel);
        const body = page.locator('.panel-body');
        switch (panel) {
          case 'tokens':
            await expect(page.getByTestId('tokens')).toContainText('main');
            await expect(page.locator('.token-stream .tok-keyword').first()).toBeVisible();
            await page.locator('.token-stream .tok').first().hover();
            await expect(page.locator('.cm-phase-highlight, .cm-phase-line').first()).toBeVisible();
            await page.locator('.tokens input[type=radio]').nth(1).check();
            await expect(page.locator('.token-stream .tok').first()).toBeVisible();
            break;
          case 'preprocess':
            await expect(body).toContainText('Preprocessor lens');
            await expect(body).toContainText('Output stream');
            await expect(page.locator('.pp-stream .tok').first()).toBeVisible();
            break;
          case 'ast':
            await expect(page.getByTestId('ast')).toContainText('FunctionDef');
            await page.locator('.ast-row').nth(1).hover();
            await page.locator('.ast-row').first().click();
            break;
          case 'types':
            await expect(page.getByTestId('types')).toContainText('main');
            await expect(page.getByTestId('types')).toContainText('Symbol table');
            break;
          case 'ir':
            await expect(page.getByTestId('ir')).toContainText('define');
            await page.locator('.irview .seg-toggle button', { hasText: 'CFG' }).click();
            await expect(page.getByTestId('cfg-graph')).toBeVisible();
            await page.locator('.irview select').first().selectOption('optimized');
            await page.locator('.irview .seg-toggle button', { hasText: 'text' }).click();
            await expect(page.getByTestId('ir')).toContainText('define');
            break;
          case 'optimize':
            await expect(page.getByTestId('optimize')).toContainText('Passes');
            await expect(page.getByTestId('optimize')).toContainText('instructions');
            break;
          case 'asm':
            await expect(page.getByTestId('asm-listing')).toContainText('main:');
            await expect(page.getByTestId('asm-listing')).toContainText('.section .text');
            await page.locator('.asmview .seg-toggle button', { hasText: 'live intervals' }).click();
            await expect(page.locator('.interval-chart')).toBeVisible();
            await page.locator('.asmview .seg-toggle button', { hasText: 'before regalloc' }).click();
            await expect(body).toContainText('virtual register');
            break;
        }
        await assertLayout(page);
      });
    }
  });
}

test.describe('memory, call stack and problems panels after a run', () => {
  for (const p of PROGRAMS.slice(0, 60)) {
    test(`${p.name} → memory/stack/problems`, async ({ page }) => {
      await fresh(page);
      await loadProgram(page, p.files);
      await run(page);
      await openPanel(page, 'memory');
      await expect(page.locator('.memview')).toContainText('stack');
      await expect(page.locator('.memview')).toContainText('heap');
      await openPanel(page, 'stack');
      await expect(page.locator('.panel-body')).toContainText(/call stack/i);
      await openPanel(page, 'problems');
      await expect(page.locator('.panel-body')).toContainText(/No problems|error|warning/);
      await assertLayout(page);
    });
  }
});
