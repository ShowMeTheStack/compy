import { preprocess, parse, analyze, Diagnostic, Token, SemaResult, TranslationUnit } from '@compy/cc';
import { run, RunResult } from '@compy/vm';
import { Vfs, Console, Syscalls, Memory } from '@compy/runtime';
import { createLibc } from './libc';
import { standardHeaders, SYSTEM_INCLUDE_DIRS } from './headers';

/**
 * The compile-and-run driver: the whole toolchain wired together with the
 * standard headers installed in a virtual filesystem. Handles multi-file
 * programs by preprocessing each translation unit (own macro scope, shared
 * headers) and concatenating them into one unit the interpreter links and runs
 * — the natural model for an interpreter where all external definitions are
 * visible together.
 */

export interface CompileOptions {
  /** name → source text. `.c` files are compiled+linked; others are includable. */
  files: Record<string, string>;
  /** Entry translation unit ordering hint; all `.c` files are linked anyway. */
  argv?: string[];
  stdin?: string;
  /** Deterministic __DATE__/__TIME__. */
  date?: string;
  time?: string;
}

export interface CompileRun {
  diagnostics: Diagnostic[];
  unit: TranslationUnit;
  sema: SemaResult;
  result?: RunResult;
  stdout: string;
  stderr: string;
}

export function setupVfs(files: Record<string, string>): Vfs {
  const vfs = new Vfs();
  for (const [path, text] of Object.entries(standardHeaders())) vfs.writeText(path, text);
  vfs.load(files, '/home');
  return vfs;
}

/** Preprocess + parse + analyze all `.c` files into a single linked unit. */
export function compile(files: Record<string, string>, opts: { date?: string; time?: string } = {}): {
  unit: TranslationUnit;
  sema: SemaResult;
  diagnostics: Diagnostic[];
  vfs: Vfs;
} {
  const vfs = setupVfs(files);
  const readFile = (p: string): string | null => (vfs.isFile(p) ? vfs.readText(p) : null);
  const diagnostics: Diagnostic[] = [];
  const allTokens: Token[] = [];

  const cFiles = Object.keys(files).filter((n) => n.endsWith('.c'));
  const order = cFiles.sort((a, b) => (a === 'main.c' ? -1 : b === 'main.c' ? 1 : a.localeCompare(b)));

  for (const name of order) {
    const path = name.startsWith('/') ? name : '/home/' + name;
    const { tokens, diagnostics: ppDiags } = preprocess(files[name]!, {
      file: path,
      systemDirs: SYSTEM_INCLUDE_DIRS,
      readFile,
      date: opts.date,
      time: opts.time,
    });
    diagnostics.push(...ppDiags);
    for (const t of tokens) if (t.kind !== 'eof') allTokens.push(t);
  }
  allTokens.push({ kind: 'eof', value: '', span: zeroSpan(), atBol: true, spaceBefore: false });

  const { unit, diagnostics: pDiags } = parse(allTokens);
  diagnostics.push(...pDiags);
  const sema = analyze(unit);
  diagnostics.push(...sema.diagnostics);
  return { unit, sema, diagnostics, vfs };
}

export function compileAndRun(opts: CompileOptions): CompileRun {
  const { unit, sema, diagnostics, vfs } = compile(opts.files, { date: opts.date, time: opts.time });
  const con = new Console();
  if (opts.stdin) con.feed(opts.stdin);
  con.closeInput();
  const sys = new Syscalls(vfs, con);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  let result: RunResult | undefined;
  if (errors.length === 0) {
    result = run(unit, sema, { console: con, vfs, syscalls: sys, memory: new Memory(), natives: createLibc(), argv: opts.argv });
  }
  return { diagnostics, unit, sema, result, stdout: con.stdout(), stderr: con.stderr() };
}

function zeroSpan() {
  const p = { file: '<link>', line: 1, col: 1, offset: 0 };
  return { start: p, end: p };
}
