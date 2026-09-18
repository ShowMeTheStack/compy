import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.getByTestId('mode-lab').click();
  await expect(page.getByTestId('lab-presets')).toBeVisible();
});

test('mode switch persists and the compiler is untouched', async ({ page }) => {
  expect(await page.evaluate(() => localStorage.getItem('compy.mode.v1'))).toBe('lab');
  await page.getByTestId('mode-c89').click();
  await expect(page.getByTestId('run')).toBeVisible();
  await page.getByTestId('run').click();
  await expect(page.getByTestId('console')).toContainText('Hello, world!');
});

test('lexer lab: rules → NFA, DFA, minimal DFA, token stream and scanner stepper', async ({ page }) => {
  await page.getByTestId('lab-presets').selectOption('Lexer playground');
  await page.getByTestId('lab-tab-tokens').click();
  await expect(page.getByTestId('lab-tokens')).toContainText('IF');
  await expect(page.getByTestId('lab-tokens')).toContainText('LE');
  await page.getByTestId('lex-stepper-next').click();
  await page.getByTestId('lex-stepper-next').click();
  await expect(page.getByTestId('lex-step')).toBeVisible();
  await page.getByTestId('lab-tab-automata').click();
  await expect(page.getByTestId('nfa')).toBeVisible();
  await page.locator('.automata .seg-toggle button', { hasText: 'minimal DFA' }).click();
  await expect(page.getByTestId('min-dfa')).toBeVisible();
  // Membership tester on a custom regex.
  await page.getByTestId('regex-input').fill('(a|b)*abb');
  await page.locator('.automata .seg-toggle button', { hasText: 'run a string' }).click();
  await page.getByTestId('probe').fill('aabb');
  await expect(page.getByTestId('verdict')).toContainText('accepted');
  await page.getByTestId('probe').fill('aab');
  await expect(page.getByTestId('verdict')).toContainText('rejected');
});

test('grammar lab: LALR(1) parse steps, item sets, tree', async ({ page }) => {
  await page.getByTestId('lab-presets').selectOption('Arithmetic (left-recursive, for LR)');
  await page.getByTestId('lab-tab-parse').click();
  await expect(page.getByTestId('parse-verdict')).toContainText('accepted');
  await page.getByTestId('parse-stepper-next').click();
  await page.getByTestId('parse-stepper-next').click();
  await expect(page.getByTestId('parse-step')).toContainText(/shift|reduce/);
  await expect(page.getByTestId('goto-graph')).toBeVisible();
  await page.locator('.parseview .seg-toggle button', { hasText: 'ACTION' }).click();
  await expect(page.getByTestId('lr-table')).toContainText('acc');
  await page.getByTestId('lab-tab-tree').click();
  await expect(page.getByTestId('tree')).toContainText('expr(');
});

test('LL(1) is blocked by left recursion; the fix button unblocks it', async ({ page }) => {
  await page.getByTestId('lab-presets').selectOption('Arithmetic (left-recursive, for LR)');
  await page.getByTestId('lab-tab-parse').click();
  await page.getByTestId('parser-select').selectOption('ll1');
  await expect(page.getByTestId('parse')).toContainText('cannot use this grammar');
  await page.getByTestId('lab-tab-analysis').click();
  await page.locator('.analysis .seg-toggle button', { hasText: 'checks' }).click();
  await page.locator('.check .btn', { hasText: 'eliminate left recursion' }).first().click();
  await page.getByTestId('lab-tab-parse').click();
  await expect(page.getByTestId('parse-verdict')).toContainText('accepted');
  await expect(page.getByTestId('ll1-table')).toBeVisible();
});

test('conflicts are reported: dangling else (SLR) and LALR merge', async ({ page }) => {
  await page.getByTestId('lab-presets').selectOption('Dangling else (SLR conflict)');
  await page.getByTestId('lab-tab-parse').click();
  await expect(page.getByTestId('conflicts')).toContainText('shift/reduce');
  await page.getByTestId('lab-presets').selectOption('LALR(1) is not LR(1)');
  await page.getByTestId('lab-tab-parse').click();
  await expect(page.getByTestId('conflicts')).toContainText('reduce/reduce');
  await page.getByTestId('parser-select').selectOption('lr1');
  await expect(page.getByTestId('conflicts')).toHaveCount(0);
});

test('Earley counts parses; CYK fills the triangle; character lexer and PDA work', async ({ page }) => {
  await page.getByTestId('lab-presets').selectOption('Ambiguous expressions');
  await page.getByTestId('lab-tab-parse').click();
  await expect(page.getByTestId('parse-verdict')).toContainText('5 parse trees');
  await expect(page.getByTestId('chart')).toBeVisible();
  await page.getByTestId('lab-presets').selectOption('Even palindromes (ambiguous for CYK)');
  await page.getByTestId('lab-tab-parse').click();
  await expect(page.getByTestId('cyk')).toBeVisible();
  await expect(page.getByTestId('parse-verdict')).toContainText('accepted');
  await page.getByTestId('lab-presets').selectOption('aⁿbⁿ');
  await page.getByTestId('lab-tab-analysis').click();
  await page.locator('.analysis .seg-toggle button', { hasText: 'pushdown' }).click();
  await expect(page.getByTestId('pda')).toContainText('accepted');
  await page.getByTestId('pda-stepper-next').click();
  await expect(page.locator('.config').first()).toBeVisible();
});

test('a lab lesson loads its preset and opens the right panel', async ({ page }) => {
  await page.getByTestId('lab-tab-learn').click();
  await page.getByTestId('lab-lesson-subset-construction').click();
  await page.getByTestId('lab-lesson-load').click();
  await expect(page.getByTestId('automata')).toBeVisible();
});
