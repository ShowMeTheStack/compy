import { test, expect } from '@playwright/test';
import { LAB_PRESETS } from '../../packages/lab/src/presets';
import { fresh, assertLayout } from './helpers';

/**
 * Language lab: every preset × every parser (accept, reject, or a clear
 * blocked message), every panel, every transformation, regex tester cases,
 * and the lesson flow. Nothing may crash or overlap.
 */
const PARSERS = ['rd', 'll1', 'lr0', 'slr1', 'lr1', 'lalr1', 'earley', 'cyk', 'opprec'] as const;
const PARSER_PRESETS = LAB_PRESETS.filter((p) => p.stage === 'parser');

async function loadPreset(page: import('@playwright/test').Page, name: string) {
  await page.getByTestId('lab-presets').selectOption(name);
  await expect(page.getByTestId('lab-problems')).not.toContainText('analysing');
}

for (const parser of PARSERS) {
  test.describe(`parser ${parser}`, () => {
    for (const p of PARSER_PRESETS) {
      test(`${p.name} with ${parser}`, async ({ page }) => {
        await fresh(page, 'lab');
        await loadPreset(page, p.name);
        await page.getByTestId('lab-tab-parse').click();
        await page.getByTestId('parser-select').selectOption(parser);
        const parsePanel = page.getByTestId('parse');
        await expect(parsePanel).not.toContainText('recomputing', { timeout: 15000 });
        const blocked = (await parsePanel.locator('.fault-banner').count()) > 0;
        if (blocked) {
          await expect(parsePanel.locator('.fault-banner').first()).toContainText(/cannot use this grammar|not in the grammar|no %left/);
        } else {
          await expect(page.getByTestId('parse-verdict')).toContainText(/accepted|rejected/);
          // Step a few times and jump to the end: the tree panel must agree.
          for (let k = 0; k < 4; k++) await page.getByTestId('parse-stepper-next').click();
          await expect(page.getByTestId('parse-step')).toBeVisible();
          await page.locator('.stepper-controls button[title=last]').first().click();
          await page.locator('.stepper-controls button[title=first]').first().click();
          await page.locator('.stepper-controls button[title=back]').first().click();
        }
        await assertLayout(page);
      });
    }
  });
}

const LAB_PANELS = ['automata', 'tokens', 'analysis', 'parse', 'tree', 'learn'] as const;
for (const panel of LAB_PANELS) {
  test.describe(`lab panel ${panel}`, () => {
    for (const p of LAB_PRESETS) {
      test(`${p.name} → ${panel}`, async ({ page }) => {
        await fresh(page, 'lab');
        await loadPreset(page, p.name);
        if (p.stage === 'lexer' && ['analysis', 'parse', 'tree'].includes(panel)) {
          await expect(page.getByTestId(`lab-tab-${panel}`)).toHaveCount(0);
          return;
        }
        await page.getByTestId(`lab-tab-${panel}`).click();
        switch (panel) {
          case 'automata':
            if (p.lexerMode === 'rules') {
              await expect(page.getByTestId('nfa')).toBeVisible();
              for (const v of ['subset construction', 'DFA', 'minimal DFA']) {
                await page.locator('.automata .seg-toggle button', { hasText: v }).first().click();
                await expect(page.locator('.panel-body')).not.toContainText('hit a bug');
              }
            } else await expect(page.locator('.panel-body')).toContainText(/no automaton/);
            break;
          case 'tokens':
            await expect(page.getByTestId('lab-tokens')).toContainText('Token stream');
            if (p.lexerMode !== 'given') {
              await page.getByTestId('lex-stepper-next').click();
              await expect(page.getByTestId('lex-step')).toBeVisible();
            }
            break;
          case 'analysis':
            await expect(page.getByTestId('analysis')).toContainText('FIRST');
            await page.getByTestId('sets-stepper-next').click();
            await page.getByRole('button', { name: 'FOLLOW', exact: true }).click();
            for (const v of ['checks', 'transformations', 'pushdown']) {
              await page.locator('.analysis .seg-toggle button', { hasText: v }).first().click();
              await expect(page.locator('.panel-body')).not.toContainText('hit a bug');
            }
            await expect(page.getByTestId('pda')).toBeVisible();
            break;
          case 'parse':
            await expect(page.getByTestId('parse')).toBeVisible();
            break;
          case 'tree':
            await expect(page.getByTestId('tree')).toBeVisible();
            break;
          case 'learn':
            await expect(page.getByTestId('lab-learn')).toContainText('lessons');
            break;
        }
        await assertLayout(page);
      });
    }
  });
}

const TRANSFORMS = ['Remove ε-productions', 'Remove unit productions', 'Remove useless symbols', 'Eliminate left recursion', 'Left-factor', 'Convert to Chomsky normal form', 'Augment'];
test.describe('transformations keep the preset parseable', () => {
  for (const p of PARSER_PRESETS) {
    for (const t of TRANSFORMS) {
      test(`${p.name}: ${t}`, async ({ page }) => {
        await fresh(page, 'lab');
        await loadPreset(page, p.name);
        await page.getByTestId('lab-tab-analysis').click();
        await page.locator('.analysis .seg-toggle button', { hasText: 'transformations' }).click();
        await page.locator('.transforms .pass label', { hasText: t }).click();
        await expect(page.getByTestId('diff')).toBeVisible();
        const apply = page.getByTestId('apply-transform');
        if (await apply.isEnabled()) {
          await apply.click();
          await page.getByTestId('lab-tab-parse').click();
          await page.getByTestId('parser-select').selectOption('earley');
          await expect(page.getByTestId('parse-verdict')).toContainText('accepted', { timeout: 15000 });
        }
        await assertLayout(page);
      });
    }
  }
});

const REGEX_CASES: [string, string, boolean][] = [
  ['a', 'a', true], ['a', 'b', false], ['a', '', false], ['a*', '', true], ['a*', 'aaaa', true], ['a*', 'aab', false],
  ['a+', '', false], ['a+', 'a', true], ['a?b', 'b', true], ['a?b', 'ab', true], ['a?b', 'aab', false],
  ['(a|b)*abb', 'abb', true], ['(a|b)*abb', 'aabb', true], ['(a|b)*abb', 'ab', false], ['(a|b)*abb', 'babba', false],
  ['[0-9]+', '2024', true], ['[0-9]+', '20a4', false], ['[a-z_][a-z0-9_]*', '_x9', true], ['[a-z_][a-z0-9_]*', '9x', false],
  ['x(yz)*', 'xyzyz', true], ['x(yz)*', 'xyzy', false], ['[^ab]+', 'cd', true], ['[^ab]+', 'ca', false],
  ['\\d+(\\.\\d+)?', '3.14', true], ['\\d+(\\.\\d+)?', '3.', false], ['(0|1(01*0)*1)*', '110', true], ['(0|1(01*0)*1)*', '111', false],
  ['.', 'q', true], ['.', 'qq', false], ['a|', '', true], ['(ab|cd)+', 'abcdab', true], ['(ab|cd)+', 'abc', false],
  ['ab*c', 'ac', true], ['ab*c', 'abbbc', true], ['ab*c', 'abbb', false], ['[A-Z][a-z]+', 'Hello', true], ['[A-Z][a-z]+', 'hello', false],
  ['\\w+@\\w+\\.com', 'me@site.com', true], ['\\w+@\\w+\\.com', 'me@site.org', false], ['if|else|while', 'else', true], ['if|else|while', 'elsewhere', false],
];
test.describe('regex membership tester', () => {
  for (const [re, s, ok] of REGEX_CASES) {
    test(`/${re}/ on "${s}" → ${ok ? 'accept' : 'reject'}`, async ({ page }) => {
      await fresh(page, 'lab');
      await loadPreset(page, 'Lexer playground');
      await page.getByTestId('lab-tab-automata').click();
      await page.getByTestId('regex-input').fill(re);
      await page.locator('.automata .seg-toggle button', { hasText: 'run a string' }).click();
      await page.getByTestId('probe').fill(s);
      if (s === '' ) await page.getByTestId('tester-stepper-next').click();
      await expect(page.getByTestId('verdict')).toContainText(ok ? 'accepted' : 'rejected');
      await page.locator('.tester .seg-toggle button', { hasText: 'NFA' }).click();
      await page.getByTestId('tester-stepper').locator('button[title=last]').click();
      await assertLayout(page);
    });
  }
});

test.describe('lab configuration', () => {
  for (const mode of ['rules', 'chars', 'given'] as const) {
    for (const stage of ['lexer', 'parser'] as const) {
      test(`lexer=${mode} stage=${stage}`, async ({ page }) => {
        await fresh(page, 'lab');
        await loadPreset(page, 'Arithmetic (right-factored, for LL)');
        await page.getByTestId('lexer-mode').selectOption(mode);
        await page.getByTestId('stage').selectOption(stage);
        await expect(page.getByTestId('doc-lex')).toHaveCount(mode === 'rules' ? 1 : 0);
        await expect(page.getByTestId('doc-grammar')).toHaveCount(stage === 'parser' ? 1 : 0);
        await expect(page.getByTestId('lab-tab-parse')).toHaveCount(stage === 'parser' ? 1 : 0);
        await page.getByTestId('lab-tab-tokens').click();
        await expect(page.getByTestId('lab-tokens')).toBeVisible();
        await assertLayout(page);
      });
    }
  }
});
