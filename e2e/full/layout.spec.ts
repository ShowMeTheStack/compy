import { test, expect } from '@playwright/test';
import { EXAMPLES } from '../../packages/ide/src/examples';
import { LAB_PRESETS } from '../../packages/lab/src/presets';
import { fresh, loadProgram, openPanel, assertLayout, run } from './helpers';

/**
 * Layout at several viewport sizes: every panel of both modes, before and
 * after running / debugging, with no overflow and no overlap, plus the
 * mode switch, file tabs, and toolbar states.
 */
const VIEWPORTS = [
  { w: 1024, h: 700 },
  { w: 1280, h: 800 },
  { w: 1600, h: 1000 },
  { w: 1920, h: 1080 },
];
const COMPILER_PANELS = ['tokens', 'preprocess', 'ast', 'types', 'ir', 'optimize', 'asm', 'memory', 'stack', 'problems', 'assistant', 'learn'];
const SAMPLE = EXAMPLES.filter((_, k) => k % 6 === 0);

for (const vp of VIEWPORTS) {
  test.describe(`viewport ${vp.w}×${vp.h}`, () => {
    for (const panel of COMPILER_PANELS) {
      for (const ex of SAMPLE) {
        test(`compiler: ${ex.name} → ${panel} (before and after run)`, async ({ page }) => {
          await page.setViewportSize({ width: vp.w, height: vp.h });
          await fresh(page);
          await loadProgram(page, ex.files);
          await openPanel(page, panel);
          await assertLayout(page);
          await run(page);
          await openPanel(page, panel);
          await assertLayout(page);
          await page.getByTestId('debug').click();
          await expect(page.locator('.step-count')).toContainText(/step/, { timeout: 20000 });
          await openPanel(page, panel);
          await assertLayout(page);
        });
      }
    }
    for (const preset of LAB_PRESETS) {
      test(`lab: ${preset.name} every panel`, async ({ page }) => {
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await fresh(page, 'lab');
        await page.getByTestId('lab-presets').selectOption(preset.name);
        for (const p of ['automata', 'tokens', 'analysis', 'parse', 'tree', 'learn']) {
          if ((await page.getByTestId(`lab-tab-${p}`).count()) === 0) continue;
          await page.getByTestId(`lab-tab-${p}`).click();
          await assertLayout(page);
        }
        await page.getByTestId('mode-c89').click();
        await assertLayout(page);
      });
    }
  });
}

test.describe('file tabs and toolbar states', () => {
  for (const ex of EXAMPLES.filter((e) => Object.keys(e.files).length > 1 || e.category === 'Basics')) {
    test(`${ex.name}: tabs, add file, remove file, switch, run`, async ({ page }) => {
      await fresh(page);
      await loadProgram(page, ex.files);
      const n = Object.keys(ex.files).length;
      await expect(page.locator('.tab:not(.add)')).toHaveCount(n);
      page.once('dialog', (d) => d.accept('extra.h'));
      await page.locator('.tab.add').click();
      await expect(page.locator('.tab.active')).toContainText('extra.h');
      await page.locator('.tab:not(.add)').first().click();
      await page.locator('.tab', { hasText: 'extra.h' }).locator('.close').click();
      await expect(page.locator('.tab:not(.add)')).toHaveCount(n);
      await run(page);
      await assertLayout(page);
    });
  }
});
