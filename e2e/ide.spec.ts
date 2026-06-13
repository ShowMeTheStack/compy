import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Start each test from a clean project (clear persisted state).
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('editor')).toBeVisible();
});

test('loads with the Hello world example and runs it', async ({ page }) => {
  await page.getByTestId('run').click();
  await expect(page.getByTestId('console')).toContainText('Hello, world!');
  await expect(page.getByTestId('console')).toContainText('exited with code 0');
});

test('shows the process memory layout after running', async ({ page }) => {
  await page.getByTestId('run').click();
  // The memory panel lists the standard segments.
  const panel = page.locator('.panel');
  await expect(panel).toContainText('stack');
  await expect(panel).toContainText('heap');
  await expect(panel).toContainText('rodata');
  await expect(panel).toContainText('data');
});

test('malloc example shows a heap block; UAF example is caught', async ({ page }) => {
  // Select the malloc example and run it.
  await page.locator('.examples').selectOption('malloc & the heap');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('console')).toContainText('0 1 4 9 16');

  // Now the use-after-free example: the sandbox reports the fault.
  await page.locator('.examples').selectOption('Use-after-free (bug!)');
  await page.getByTestId('run').click();
  await expect(page.locator('.fault-banner')).toContainText('use-after-free');
});

test('debugger steps and shows the call stack', async ({ page }) => {
  await page.locator('.examples').selectOption('Factorial (recursion)');
  await page.getByTestId('debug').click();
  // Step a few times, then open the call-stack panel.
  await page.locator('button[title="Step into"]').click();
  await page.locator('button[title="Step into"]').click();
  await page.locator('.panel-tabs button', { hasText: 'Call stack' }).click();
  await expect(page.locator('.callstack')).toContainText('main');
});

test('reports errors in the Problems panel', async ({ page }) => {
  // Type an undeclared identifier.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('int main(void){ return zzz; }');
  await page.locator('.panel-tabs button', { hasText: 'Problems' }).click();
  await expect(page.locator('.problems')).toContainText("'zzz' undeclared");
});

test('the offline AI assistant answers questions', async ({ page }) => {
  await page.locator('.panel-tabs button', { hasText: 'AI' }).click();
  await expect(page.getByTestId('chat')).toContainText('Offline assistant');
  await page.getByTestId('chat-input').fill('how do pointers work?');
  await page.getByTestId('chat-send').click();
  await expect(page.locator('.msg.assistant')).toContainText(/address/i);
});

test('an assistant code block can be copied into a new file', async ({ page }) => {
  await page.locator('.panel-tabs button', { hasText: 'AI' }).click();
  await page.getByTestId('chat-input').fill('write a program to sort numbers');
  await page.getByTestId('chat-send').click();
  await expect(page.locator('.code-block')).toBeVisible();
  await page.locator('.code-actions button', { hasText: 'copy to file' }).first().click();
  // A new snippet file tab appears.
  await expect(page.locator('.tab', { hasText: 'snippet' })).toBeVisible();
});
