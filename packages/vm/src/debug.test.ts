import { describe, it, expect } from 'vitest';
import { preprocess, parse, analyze } from '@compy/cc';
import { run } from './interp';
import { Debugger, StopEvent } from './debug';
import { Console } from '@compy/runtime';

function compile(src: string) {
  const { tokens } = preprocess(src, { file: '/home/main.c' });
  const { unit } = parse(tokens);
  return { unit, sema: analyze(unit) };
}

// Line numbers are 1-based; line 1 is the first line of `src` below.
const SRC = `int add(int x, int y) {
  int s = x + y;
  return s;
}
int main(void) {
  int a = 3;
  int b = 4;
  int c = add(a, b);
  return c;
}`;

describe('breakpoints', () => {
  it('stops at a breakpoint with the right frame and locals', () => {
    const { unit, sema } = compile(SRC);
    const dbg = new Debugger();
    dbg.addBreakpoint(8, '/home/main.c'); // `int c = add(a, b);`
    let hit: StopEvent | null = null;
    dbg.onPause = (d, ev) => {
      hit = ev;
      d.continue_();
    };
    run(unit, sema, { console: new Console(), debug: dbg });
    expect(hit).not.toBeNull();
    const ev = hit!;
    expect(ev.reason).toBe('breakpoint');
    expect(ev.func).toBe('main');
    expect(ev.line).toBe(8);
    const vars = Object.fromEntries(ev.locals.map((v) => [v.name, v.value]));
    expect(vars['a']).toBe('3');
    expect(vars['b']).toBe('4');
  });
});

describe('stepping', () => {
  it('step in enters the callee; step out returns to the caller', () => {
    const { unit, sema } = compile(SRC);
    const dbg = new Debugger();
    dbg.addBreakpoint(8, '/home/main.c');
    const seen: string[] = [];
    let phase = 0;
    dbg.onPause = (d, ev) => {
      seen.push(`${ev.func}@${ev.line}#${ev.depth}`);
      if (phase === 0) d.stepIn(); // from the call -> into add
      else if (phase === 1) d.stepOut(); // out of add -> back to main
      else d.continue_();
      phase++;
    };
    run(unit, sema, { console: new Console(), debug: dbg });
    expect(seen[0]).toBe('main@8#1');
    expect(seen[1]!.startsWith('add@')).toBe(true);
    expect(seen[1]).toContain('#2'); // depth 2 inside add
    expect(seen[2]!.startsWith('main@')).toBe(true);
    expect(seen[2]).toContain('#1'); // back at depth 1
  });

  it('step over does not descend into calls', () => {
    const { unit, sema } = compile(SRC);
    const dbg = new Debugger();
    dbg.addBreakpoint(8, '/home/main.c');
    const funcs: string[] = [];
    dbg.onPause = (d, ev) => {
      funcs.push(ev.func);
      if (funcs.length < 3) d.stepOver();
      else d.continue_();
    };
    run(unit, sema, { console: new Console(), debug: dbg });
    // Every stop stays in main — never descends into add.
    expect(funcs.every((f) => f === 'main')).toBe(true);
    expect(funcs.length).toBeGreaterThanOrEqual(2);
  });

  it('single-steps line by line from the start', () => {
    const { unit, sema } = compile(SRC);
    const dbg = new Debugger();
    dbg.pauseNext();
    const lines: number[] = [];
    dbg.onPause = (d, ev) => {
      if (ev.func === 'main') lines.push(ev.line);
      d.stepIn();
    };
    run(unit, sema, { console: new Console(), debug: dbg });
    // main's statements execute at lines 6,7,8,9 in order.
    expect(lines.slice(0, 4)).toEqual([6, 7, 8, 9]);
  });
});

describe('watch / memory inspection', () => {
  it('reads a variable value at the current stop', () => {
    const src = `int main(void){\n  int n = 41;\n  n = n + 1;\n  return n;\n}`;
    const { unit, sema } = compile(src);
    const dbg = new Debugger();
    dbg.addBreakpoint(4, '/home/main.c'); // return n;
    let nVal = '';
    dbg.onPause = (d, ev, interp) => {
      const v = interp.frameVars().find((x) => x.name === 'n');
      nVal = v ? v.value : '';
      d.continue_();
    };
    run(unit, sema, { console: new Console(), debug: dbg });
    expect(nVal).toBe('42');
  });
});
