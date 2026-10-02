import { test, expect } from '@playwright/test';
import { EXAMPLES } from '../../packages/ide/src/examples';
import { FEATURES, FEATURE_EXTRA_FILES } from '../../packages/testgen/src/features';
import { fresh, loadProgram, setEngine, setStdin, assertLayout, openPanel, Engine } from './helpers';

/**
 * Time-travel debugging on every engine, plus the IR and machine steppers.
 */
const PROGRAMS = [
  ...EXAMPLES.filter((e) => !/bug/i.test(e.name) && !/bug/i.test(e.category)).map((e) => ({ name: `example: ${e.name}`, files: e.files, stdin: undefined as string | undefined })),
  ...FEATURES.filter((f) => !f.fault).map((f) => ({ name: `feature: ${f.name}`, files: { 'main.c': f.source, ...(FEATURE_EXTRA_FILES[f.name] ?? {}) }, stdin: f.stdin })),
];

for (const engine of ['ast', 'ir', 'machine'] as Engine[]) {
  test.describe(`debugger on ${engine}`, () => {
    for (const p of PROGRAMS) {
      test(`${p.name} [${engine}] step into/over/out/back/continue`, async ({ page }) => {
        await fresh(page);
        await loadProgram(page, p.files);
        if (p.stdin) await setStdin(page, p.stdin);
        await setEngine(page, engine);
        await page.getByTestId('debug').click();
        await expect(page.locator('.step-count')).toContainText(/step \d+\/\d+/, { timeout: 20000 });
        const count = Number((await page.locator('.step-count').innerText()).match(/\/(\d+)/)![1]);
        expect(count).toBeGreaterThan(0);
        await page.locator('button[title="Step into"]').click();
        await page.locator('button[title="Step over"]').click();
        await page.locator('button[title="Step back"]').click();
        await page.locator('button[title="Step out"]').click();
        // The memory panel shows locals or globals while paused (if still paused).
        await openPanel(page, 'memory');
        await expect(page.locator('.memview')).toContainText('Process memory layout');
        await openPanel(page, 'stack');
        await expect(page.locator('.panel-body')).toContainText(/main|Start debugging/);
        if (await page.locator('button[title="Continue"]').count()) await page.locator('button[title="Continue"]').click();
        await assertLayout(page);
      });
    }
  });
}

test.describe('IR and machine instruction steppers', () => {
  for (const p of PROGRAMS) {
    test(`${p.name}: IR stepper`, async ({ page }) => {
      await fresh(page);
      await loadProgram(page, p.files);
      if (p.stdin) await setStdin(page, p.stdin);
      await openPanel(page, 'ir');
      await page.locator('.irview .seg-toggle button', { hasText: 'step' }).click();
      await page.getByTestId('ir-trace').click();
      await expect(page.getByTestId('ir-stepper')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('ir-next').click();
      await page.getByTestId('ir-next').click();
      await expect(page.locator('.trace-row.current')).toBeVisible();
      await assertLayout(page);
    });
    test(`${p.name}: machine stepper`, async ({ page }) => {
      await fresh(page);
      await loadProgram(page, p.files);
      if (p.stdin) await setStdin(page, p.stdin);
      await openPanel(page, 'asm');
      await page.locator('.asmview .seg-toggle button', { hasText: 'step' }).click();
      await page.getByTestId('mach-trace').click();
      await expect(page.getByTestId('mach-stepper')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('mach-stepper')).toContainText('addi sp, sp');
      await page.getByTestId('mach-next').click();
      await page.getByTestId('mach-next').click();
      await expect(page.locator('.reg').first()).toBeVisible();
      await assertLayout(page);
    });
  }
});
