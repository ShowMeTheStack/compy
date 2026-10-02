import { test, expect } from '@playwright/test';
import { fresh, assertLayout, openPanel } from './helpers';

/** The offline assistant answers concept questions and points at panels. */
const QA: [string, RegExp][] = [
  ['what is a token', /token|lexer/i], ['what is a lexer', /lexer|token/i], ['what is an ast', /tree|AST|parser/i], ['what is a grammar', /grammar|production|parse/i],
  ['what is ssa', /SSA|phi/i], ['what is a phi node', /phi/i], ['what does mem2reg do', /mem2reg|register|alloca/i], ['what is a basic block', /basic block|block/i],
  ['what is a cfg', /control|graph|block/i], ['what is constant folding', /constant|fold/i], ['what is dead code elimination', /dead|remove|unused/i], ['what is cse', /common|subexpression/i],
  ['what is loop invariant code motion', /loop|hoist|invariant/i], ['what is strength reduction', /shift|strength|cheaper/i], ['what is inlining', /inlin/i],
  ['how does register allocation work', /register|allocat|spill/i], ['what is linear scan', /linear scan|interval|register/i], ['what is a calling convention', /a0|argument|calling|convention|ABI/i],
  ['what is a stack frame', /frame|stack|prologue/i], ['what is instruction selection', /instruction|select|RISC/i], ['what is risc-v', /RISC|assembly|instruction/i],
  ['how do pointers work', /address/i], ['how do I use malloc', /malloc|heap/i], ['what is an array', /array|index/i], ['explain structs', /struct|field/i],
  ['how do I write a for loop', /for/i], ['what is recursion', /recurs|base case/i], ['how do I read input', /scanf|input/i], ['how do I print a float', /printf|%f/i],
  ['what is a switch statement', /switch|case|break/i], ['what is a function', /function|return/i], ['what are strings in c', /string|\\0|char/i], ['how do I open a file', /fopen|file/i],
  ['what is use after free', /use-after-free|dangling|free/i], ['what is a null pointer dereference', /null|address 0/i], ['what is a memory leak', /leak|free/i], ['what is a stack overflow', /stack|recursion/i],
  ['what is a macro', /macro|#define|preprocessor/i], ['write a program to sort numbers', /```c/], ['write a program that reverses a string', /```c/],
  ['hello', /C helper|Hi/i], ['', /C helper|Hi/i], ['what is a symbol table', /symbol|scope/i], ['what is the ir', /IR|intermediate|instruction/i],
  ['what is optimization', /optimi|pass/i], ['what is codegen', /assembly|code|RISC/i], ['what is a parser', /parser|tree|grammar/i], ['what is parsing', /pars/i],
];

test.describe('offline AI assistant', () => {
  for (const [q, re] of QA) {
    test(`asks: "${q || '(empty)'}"`, async ({ page }) => {
      await fresh(page);
      await openPanel(page, 'assistant');
      await expect(page.getByTestId('chat')).toContainText('Offline assistant');
      await page.getByTestId('chat-input').fill(q || 'hi');
      await page.getByTestId('chat-send').click();
      if (re.source === '```c') await expect(page.locator('.msg.assistant').last().locator('.code-block')).toBeVisible();
      else await expect(page.locator('.msg.assistant').last()).toContainText(re);
      await assertLayout(page);
    });
  }
  test('code block from the assistant lands in a new file and runs', async ({ page }) => {
    await fresh(page);
    await openPanel(page, 'assistant');
    await page.getByTestId('chat-input').fill('write a program to sort numbers');
    await page.getByTestId('chat-send').click();
    await page.locator('.code-actions button', { hasText: 'copy to file' }).first().click();
    await expect(page.locator('.tab.active')).toContainText('snippet');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('console')).toContainText('exited with code');
  });
});
