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
  await page.getByTestId('examples').selectOption('malloc & the heap');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('console')).toContainText('0 1 4 9 16');

  // Now the use-after-free example: the sandbox reports the fault.
  await page.getByTestId('examples').selectOption('Use-after-free (bug!)');
  await page.getByTestId('run').click();
  await expect(page.locator('.fault-banner')).toContainText('use-after-free');
});

test('debugger steps and shows the call stack', async ({ page }) => {
  await page.getByTestId('examples').selectOption('Factorial (recursion)');
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

test('the phase bar opens the Tokens, AST, Types, IR, Optimize and Codegen panels', async ({ page }) => {
  await page.getByTestId('phase-tokens').click();
  await expect(page.getByTestId('tokens')).toContainText('printf');
  await expect(page.locator('.token-stream .tok-keyword').first()).toContainText('int');

  await page.getByTestId('phase-ast').click();
  await expect(page.getByTestId('ast')).toContainText('FunctionDef');
  await expect(page.getByTestId('ast')).toContainText('CallExpr');

  await page.getByTestId('phase-types').click();
  await expect(page.getByTestId('types')).toContainText('main');
  await expect(page.getByTestId('types')).toContainText('int(');

  await page.getByTestId('phase-ir').click();
  await expect(page.getByTestId('ir')).toContainText('define i32 @main');
  await expect(page.getByTestId('ir')).toContainText('call i32 @printf');

  await page.getByTestId('phase-optimize').click();
  await expect(page.getByTestId('optimize')).toContainText('Promote memory to registers');

  await page.getByTestId('phase-asm').click();
  await expect(page.getByTestId('asm-listing')).toContainText('call printf');
  await expect(page.getByTestId('asm-listing')).toContainText('addi sp, sp, -');
});

test('optimizer diff shows a pass rewriting the IR; toggling a pass changes the result', async ({ page }) => {
  await page.getByTestId('examples').selectOption('Constant folding');
  await page.getByTestId('phase-optimize').click();
  await expect(page.locator('.pass-log li').first()).toBeVisible();
  await page.locator('.pass-log li').first().click();
  await expect(page.getByTestId('diff')).toBeVisible();
  await expect(page.locator('.diff-row.del').first()).toBeVisible();
  // With folding on, no arithmetic survives in main; with it off, some does.
  await page.getByTestId('phase-ir').click();
  await page.locator('.irview select').first().selectOption('optimized');
  await page.locator('.irview select').nth(1).selectOption('main');
  await expect(page.getByTestId('ir')).not.toContainText('= mul i32');
  await page.getByTestId('phase-optimize').click();
  await page.getByTestId('pass-constfold').uncheck();
  await page.getByTestId('phase-ir').click();
  await page.locator('.irview select').first().selectOption('optimized');
  await page.locator('.irview select').nth(1).selectOption('main');
  await expect(page.getByTestId('ir')).toContainText(/= (mul|add|sub) i32/);
});

test('the program runs identically on all three engines', async ({ page }) => {
  await page.getByTestId('examples').selectOption('Factorial (recursion)');
  for (const engine of ['ast', 'ir', 'machine']) {
    await page.getByTestId('engine').selectOption(engine);
    await page.getByTestId('run').click();
    await expect(page.getByTestId('console')).toContainText('120');
    await expect(page.getByTestId('console')).toContainText('exited with code 0');
  }
});

test('machine stepper shows registers changing', async ({ page }) => {
  await page.getByTestId('phase-asm').click();
  await page.locator('.asmview .seg-toggle button', { hasText: 'step' }).click();
  await page.getByTestId('mach-trace').click();
  await expect(page.getByTestId('mach-stepper')).toBeVisible();
  // The first instruction of main is the prologue's `addi sp, sp, -N`: sp changes.
  await expect(page.getByTestId('mach-stepper')).toContainText('addi sp, sp');
  await expect(page.locator('.reg.changed').first()).toContainText('sp =');
  await page.getByTestId('mach-next').click();
  await expect(page.getByTestId('mach-stepper')).toContainText('instr 2/');
});

test('IR stepper replays the IR interpreter', async ({ page }) => {
  await page.getByTestId('phase-ir').click();
  await page.locator('.irview .seg-toggle button', { hasText: 'step' }).click();
  await page.getByTestId('ir-trace').click();
  await expect(page.getByTestId('ir-stepper')).toBeVisible();
  await page.getByTestId('ir-next').click();
  await expect(page.getByTestId('ir-stepper')).toContainText('@main');
});

test('a lesson loads its example into the editor', async ({ page }) => {
  await page.locator('.panel-tabs button', { hasText: 'Learn' }).click();
  await expect(page.getByTestId('learn')).toBeVisible();
  await page.locator('.lesson-list button').first().click();
  await page.getByTestId('lesson-load').click();
  await expect(page.locator('.tab.active')).toContainText('.c');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('console')).toContainText('exited with code');
});
