import { compile, compileAndRun, createLibc } from '@compy/libc';
import { Console, Memory, Syscalls } from '@compy/runtime';
import { lower } from './lower';
import { runIr } from './interp';
import { Module } from './ir';

/**
 * Test helpers shared by the IR, optimizer, and codegen suites: compile a
 * program through the front-end, lower it, and run it on a given engine,
 * returning what a differential test compares (stdout + exit code).
 */
export interface Outcome {
  stdout: string;
  stderr: string;
  exit: number;
}

export function lowerSource(files: Record<string, string> | string): { module: Module; errors: string[] } {
  const f = typeof files === 'string' ? { 'main.c': files } : files;
  const c = compile(f);
  const errors = c.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
  const { module, diagnostics } = lower(c.unit, c.sema);
  errors.push(...diagnostics.filter((d) => d.severity === 'error').map((d) => d.message));
  return { module, errors };
}

export function runTreeWalker(src: string, stdin = '', argv = ['prog']): Outcome {
  const r = compileAndRun({ files: { 'main.c': src }, stdin, argv });
  return { stdout: r.stdout, stderr: r.stderr, exit: r.result?.exitCode ?? -1 };
}

export function runModule(mod: Module, files: Record<string, string>, stdin = '', argv = ['prog']): Outcome {
  const c = compile(files);
  const con = new Console();
  if (stdin) con.feed(stdin);
  con.closeInput();
  const sys = new Syscalls(c.vfs, con);
  const r = runIr(mod, { console: con, vfs: c.vfs, syscalls: sys, memory: new Memory(), natives: createLibc(), argv });
  return { stdout: con.stdout(), stderr: con.stderr(), exit: r.exitCode };
}

export function runIrSource(src: string, stdin = '', argv = ['prog']): Outcome {
  const { module, errors } = lowerSource(src);
  if (errors.length) throw new Error('lowering failed: ' + errors.join('; '));
  return runModule(module, { 'main.c': src }, stdin, argv);
}
