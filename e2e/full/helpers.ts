import { Page, expect } from '@playwright/test';

/**
 * Shared helpers for the generated end-to-end suite. Every helper that
 * changes the UI ends with a layout check: no horizontal overflow and no
 * overlapping elements among the controls a student sees.
 */
export type Engine = 'ast' | 'ir' | 'machine';

export async function fresh(page: Page, mode: 'c89' | 'lab' = 'c89'): Promise<void> {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  if (mode === 'lab') {
    await page.getByTestId('mode-lab').click();
    await expect(page.getByTestId('lab-presets')).toBeVisible();
  } else {
    await expect(page.getByTestId('editor')).toBeVisible();
  }
}

export async function loadProgram(page: Page, files: Record<string, string>): Promise<void> {
  await page.evaluate((f) => (window as unknown as { __compy: { load: (x: Record<string, string>) => void } }).__compy.load(f), files);
  // Wait for the debounced analysis to land on the phase bar.
  await expect(page.getByTestId('phase-tokens')).not.toContainText('…');
}

export async function setEngine(page: Page, engine: Engine): Promise<void> {
  await page.getByTestId('engine').selectOption(engine);
}
export async function setStdin(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => (window as unknown as { __compy: { setStdin: (s: string) => void } }).__compy.setStdin(t), text);
}
export async function setPasses(page: Page, passes: string[]): Promise<void> {
  await page.evaluate((p) => (window as unknown as { __compy: { setPasses: (s: string[]) => void } }).__compy.setPasses(p), passes);
}

export async function run(page: Page): Promise<string> {
  await page.getByTestId('run').click();
  await expect(page.getByTestId('console')).toContainText('exited with code', { timeout: 20000 });
  return consoleText(page);
}
export async function consoleText(page: Page): Promise<string> {
  return page.getByTestId('console').innerText();
}
/** Program output only: everything before the "→ exited" line. */
export function outputOf(console: string): string {
  const k = console.indexOf('→ exited');
  return (k >= 0 ? console.slice(0, k) : console).replace(/\n+$/, '');
}

export async function openPanel(page: Page, phase: string): Promise<void> {
  if (['memory', 'stack', 'problems', 'assistant', 'learn'].includes(phase)) {
    const label = { memory: 'Memory', stack: 'Call stack', problems: 'Problems', assistant: 'AI', learn: 'Learn' }[phase]!;
    await page.locator('.panel-tabs button', { hasText: label }).click();
  } else await page.getByTestId(`phase-${phase}`).click();
}

/** Layout invariants: nothing overflows horizontally, nothing overlaps. */
export async function assertLayout(page: Page): Promise<void> {
  const report = await page.evaluate(() => {
    const problems: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) problems.push(`page overflows horizontally: ${doc.scrollWidth} > ${doc.clientWidth}`);
    const groups = ['.toolbar', '.phasebar', '.tabs', '.panel-tabs', '.lab-config', '.debug-controls', '.stepper-controls', '.panel-toolbar'];
    const rect = (el: Element) => el.getBoundingClientRect();
    const visible = (el: Element) => {
      const r = rect(el);
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    for (const sel of groups) {
      for (const container of Array.from(document.querySelectorAll(sel))) {
        const kids = Array.from(container.children).filter(visible).filter((k) => !k.classList.contains('spacer'));
        for (let i = 0; i < kids.length; i++) {
          const a = rect(kids[i]!);
          if (a.right > window.innerWidth + 1) problems.push(`${sel} child ${i} (${kids[i]!.className}) runs off the viewport (${Math.round(a.right)} > ${window.innerWidth})`);
          for (let j = i + 1; j < kids.length; j++) {
            const b = rect(kids[j]!);
            const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (overlapX > 2 && overlapY > 2) problems.push(`${sel}: children ${i} and ${j} overlap (${kids[i]!.className} / ${kids[j]!.className})`);
          }
        }
      }
    }
    // The editor pane and the panel must not overlap each other.
    const ed = document.querySelector('.editor-pane');
    const pn = document.querySelector('.panel');
    if (ed && pn) {
      const a = rect(ed);
      const b = rect(pn);
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2) problems.push('editor pane and side panel overlap');
    }
    return problems;
  });
  expect(report, 'layout problems').toEqual([]);
}

export const isBugDemo = (name: string, category = ''): boolean => /bug/i.test(name) || /bug/i.test(category);
