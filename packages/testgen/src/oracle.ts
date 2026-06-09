import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileAndRun } from '@cide/libc';

/**
 * The differential oracle: compile+run a C program with the real system
 * compiler (Apple clang) and with our interpreter, and compare stdout and the
 * exit code byte-for-byte. This is the ground-truth correctness check for the
 * whole toolchain. clang is invoked with -std=c89 so both engines agree on the
 * dialect.
 */

export interface OracleResult {
  match: boolean;
  clang: { stdout: string; exit: number };
  cide: { stdout: string; exit: number };
  reason?: string;
}

let clangChecked: boolean | null = null;

export function hasClang(): boolean {
  if (clangChecked !== null) return clangChecked;
  try {
    execFileSync('clang', ['--version'], { stdio: 'ignore' });
    clangChecked = true;
  } catch {
    clangChecked = false;
  }
  return clangChecked;
}

export function runWithClang(source: string, stdin = '', argv: string[] = []): { stdout: string; exit: number } {
  const dir = mkdtempSync(join(tmpdir(), 'cide-oracle-'));
  const src = join(dir, 'prog.c');
  const bin = join(dir, 'prog');
  try {
    writeFileSync(src, source);
    execFileSync('clang', ['-std=c89', '-Wno-everything', '-o', bin, src], { stdio: 'ignore' });
    let stdout = '';
    let exit = 0;
    try {
      stdout = execFileSync(bin, argv.slice(1), { input: stdin, encoding: 'utf8', timeout: 10_000 });
    } catch (e) {
      const err = e as { status?: number; stdout?: string | Buffer };
      exit = typeof err.status === 'number' ? err.status : 1;
      stdout = err.stdout ? err.stdout.toString() : '';
    }
    return { stdout, exit };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function runWithCide(source: string, stdin = '', argv: string[] = ['prog']): { stdout: string; exit: number } {
  const r = compileAndRun({ files: { 'main.c': source }, stdin, argv });
  return { stdout: r.stdout, exit: r.result?.exitCode ?? -1 };
}

/** Run a program on both engines and compare. */
export function differential(source: string, stdin = '', argv: string[] = ['prog']): OracleResult {
  const clang = runWithClang(source, stdin, argv);
  const cide = runWithCide(source, stdin, argv);
  const match = clang.stdout === cide.stdout && (clang.exit & 0xff) === (cide.exit & 0xff);
  return {
    match,
    clang,
    cide,
    reason: match ? undefined : clang.stdout !== cide.stdout ? 'stdout differs' : 'exit code differs',
  };
}
