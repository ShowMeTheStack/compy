import { test, expect } from '@playwright/test';
import { LESSONS } from '../../packages/ide/src/lessons';
import { LAB_LESSONS } from '../../packages/ide/src/labLessons';
import { fresh, assertLayout, run } from './helpers';

/** Every lesson in both modes: opens, loads its program/preset, and the target panel renders. */
test.describe('compiler lessons', () => {
  for (const l of LESSONS) {
    test(`${l.title}`, async ({ page }) => {
      await fresh(page);
      await page.locator('.panel-tabs button', { hasText: 'Learn' }).click();
      await page.getByTestId(`lesson-${l.id}`).click();
      await expect(page.getByTestId('learn')).toContainText(l.title);
      await expect(page.locator('.try-this li').first()).toBeVisible();
      await page.getByTestId('lesson-load').click();
      await expect(page.locator('.tab.active')).toContainText(l.id);
      const out = await run(page);
      expect(out).toContain('exited with code 0');
      await page.locator('.panel-tabs button', { hasText: 'Learn' }).click();
      await page.getByTestId(`lesson-${l.id}`).click();
      await page.locator('.learn .btn', { hasText: 'Open the' }).click();
      await expect(page.locator('.panel-body')).not.toContainText('hit a bug');
      await assertLayout(page);
    });
  }
});

test.describe('lab lessons', () => {
  for (const l of LAB_LESSONS) {
    test(`${l.title}`, async ({ page }) => {
      await fresh(page, 'lab');
      await page.getByTestId('lab-tab-learn').click();
      await page.getByTestId(`lab-lesson-${l.id}`).click();
      await expect(page.getByTestId('lab-learn')).toContainText(l.title);
      await page.getByTestId('lab-lesson-load').click();
      await expect(page.getByTestId(l.panel === 'tokens' ? 'lab-tokens' : l.panel)).toBeVisible({ timeout: 15000 });
      await expect(page.locator('.panel-body')).not.toContainText('hit a bug');
      await assertLayout(page);
    });
  }
});
