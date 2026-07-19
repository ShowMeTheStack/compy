import { describe, it, expect } from 'vitest';
import { CORPUS } from '@compy/testgen';
import { compile, createLibc } from '@compy/libc';
import { Console, Memory, Syscalls } from '@compy/runtime';
import { lower, optimize, Module } from '@compy/ir';
import { EXTRA_PROGRAMS } from '../../ir/src/extra-programs';
import { runTreeWalker } from '../../ir/src/harness';
import { codegen, Simulator, AllocStrategy } from './index';

const ALL = [...CORPUS, ...EXTRA_PROGRAMS];

function build(src: string, opt: boolean): Module {
  const c = compile({ 'main.c': src });
  const errs = c.diagnostics.filter((d) => d.severity === 'error');
  if (errs.length) throw new Error(errs.map((d) => d.message).join('; '));
  const { module, diagnostics } = lower(c.unit, c.sema);
  if (diagnostics.some((d) => d.severity === 'error')) throw new Error('lowering failed');
  return opt ? optimize(module).module : module;
}

export function runMachine(src: string, opts: { opt: boolean; strategy: AllocStrategy }, stdin = ''): { stdout: string; stderr: string; exit: number; asm: string } {
  const ir = build(src, opts.opt);
  const cg = codegen(ir, { strategy: opts.strategy });
  const c = compile({ 'main.c': src });
  const con = new Console();
  if (stdin) con.feed(stdin);
  con.closeInput();
  const sys = new Syscalls(c.vfs, con);
  const sim = new Simulator(cg.mmod, ir, { console: con, vfs: c.vfs, syscalls: sys, memory: new Memory(), natives: createLibc(), argv: ['prog'] });
  const r = sim.run();
  return { stdout: con.stdout(), stderr: con.stderr(), exit: r.exitCode, asm: cg.asm };
}

const CONFIGS: { name: string; opt: boolean; strategy: AllocStrategy }[] = [
  { name: 'O0 + naive allocator', opt: false, strategy: 'naive' },
  { name: 'O0 + linear scan', opt: false, strategy: 'linear-scan' },
  { name: 'O2 + naive allocator', opt: true, strategy: 'naive' },
  { name: 'O2 + linear scan', opt: true, strategy: 'linear-scan' },
];

for (const cfg of CONFIGS) {
  describe(`generated RV32 code matches the tree-walker (${cfg.name})`, () => {
    for (const prog of ALL) {
      it(prog.name, () => {
        const expected = runTreeWalker(prog.source, prog.stdin ?? '');
        const got = runMachine(prog.source, cfg, prog.stdin ?? '');
        expect(got.stdout).toBe(expected.stdout);
        expect(got.exit).toBe(expected.exit);
      });
    }
  });
}

describe('assembly listing', () => {
  it('has sections, a prologue, and source-line comments', () => {
    const src = `int sq(int x){ return x * x; }\nint main(void){ return sq(3); }`;
    const ir = build(src, false);
    const cg = codegen(ir, { source: src.split('\n') });
    expect(cg.asm).toContain('.section .text');
    expect(cg.asm).toContain('sq:');
    expect(cg.asm).toContain('addi sp, sp, -');
    expect(cg.asm).toContain('sw ra,');
    expect(cg.asm).toContain('# line 1:');
    expect(cg.asm).toContain('call sq');
    expect(cg.preRA).toMatch(/v\d+/);
  });
  it('linear scan uses fewer spills than the naive allocator', () => {
    const src = `int f(int a, int b, int c){ int i, s = 0; for (i = 0; i < a; i++) s += b * c + i; return s; }\nint main(void){ return f(3,4,5); }`;
    const ir = build(src, true);
    const naive = codegen(ir, { strategy: 'naive' });
    const scan = codegen(ir, { strategy: 'linear-scan' });
    const spills = (r: typeof naive) => r.reports.reduce((n, x) => n + x.spilled, 0);
    expect(spills(scan)).toBeLessThan(spills(naive));
    expect(spills(scan)).toBe(0);
  });
});
