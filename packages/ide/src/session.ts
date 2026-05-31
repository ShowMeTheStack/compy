import { preprocess, parse, analyze, Diagnostic, SemaResult, TranslationUnit, PPEvent, DefLink } from '@cide/cc';
import { run, Interp, Debugger, StopEvent, VarView } from '@cide/vm';
import { Memory, Console, Syscalls, SegmentName, Segment } from '@cide/runtime';
import { setupVfs, createLibc, standardHeaders, SYSTEM_INCLUDE_DIRS } from '@cide/libc';

/**
 * The IDE's orchestration layer: compiles a project for editor features
 * (diagnostics, go-to-definition, the preprocessor lens) and runs it either to
 * completion or as a recorded execution trace for time-travel debugging. Owns
 * the Memory/Console/Syscalls so the panels can inspect the machine afterward.
 */

export interface SegView {
  name: SegmentName;
  start: number;
  end: number;
  top: number;
  perm: string;
  used: number;
  size: number;
}
export interface HeapView {
  addr: number;
  size: number;
  freed: boolean;
}
export interface Snapshot {
  step: number;
  line: number;
  file: string;
  func: string;
  depth: number;
  callStack: { name: string; line: number }[];
  locals: VarView[];
  globals: VarView[];
  heap: HeapView[];
  segments: SegView[];
  outLen: number;
  errLen: number;
}

export interface Outcome {
  diagnostics: Diagnostic[];
  stdout: string;
  stderr: string;
  exitCode?: number;
  faults: { kind: string; addr: number; message: string }[];
  leaks: HeapView[];
  segments: SegView[];
  globals: VarView[];
  heap: HeapView[];
  snapshots: Snapshot[];
  truncated: boolean;
  /** The machine's memory after the run — for the byte inspector/editor. */
  mem: Memory;
}

export interface AnalyzeResult {
  diagnostics: Diagnostic[];
  unit: TranslationUnit;
  sema: SemaResult;
  defs: DefLink[];
  lens: PPEvent[];
}

const MAX_SNAPSHOTS = 20000;

function segViews(mem: Memory): SegView[] {
  return (Object.values(mem.segments) as Segment[]).map((s) => ({
    name: s.name,
    start: s.start,
    end: s.end,
    top: s.top,
    perm: s.perm,
    used: s.growsDown ? s.end - s.top : s.top - s.start,
    size: s.end - s.start,
  }));
}

/** Compile the project for editor features; also captures the preprocessor lens. */
export function analyzeProject(files: Record<string, string>, activeFile: string): AnalyzeResult {
  const vfs = setupVfs(files);
  const readFile = (p: string): string | null => (vfs.isFile(p) ? vfs.readText(p) : null);
  const lens: PPEvent[] = [];
  const diagnostics: Diagnostic[] = [];

  // Preprocess the active file with lens capture (best-effort for tooling).
  const activePath = activeFile.startsWith('/') ? activeFile : '/home/' + activeFile;
  if (files[activeFile] !== undefined) {
    const { diagnostics: d } = preprocess(files[activeFile]!, {
      file: activePath,
      systemDirs: SYSTEM_INCLUDE_DIRS,
      readFile,
      onEvent: (e) => lens.push(e),
    });
    diagnostics.push(...d);
  }

  // Full link for semantic diagnostics + go-to-def.
  const cFiles = Object.keys(files).filter((n) => n.endsWith('.c'));
  const allTokens = [];
  for (const name of cFiles) {
    const path = name.startsWith('/') ? name : '/home/' + name;
    const { tokens, diagnostics: pp } = preprocess(files[name]!, { file: path, systemDirs: SYSTEM_INCLUDE_DIRS, readFile });
    diagnostics.push(...pp);
    for (const t of tokens) if (t.kind !== 'eof') allTokens.push(t);
  }
  allTokens.push({ kind: 'eof' as const, value: '', span: zero(), atBol: true, spaceBefore: false });
  const { unit, diagnostics: pd } = parse(allTokens);
  diagnostics.push(...pd);
  const sema = analyze(unit);
  diagnostics.push(...sema.diagnostics);
  return { diagnostics, unit, sema, defs: sema.defs, lens };
}

/** Build the linked unit + a fresh machine for execution. */
function buildMachine(files: Record<string, string>, stdin: string) {
  const vfs = setupVfs(files);
  const readFile = (p: string): string | null => (vfs.isFile(p) ? vfs.readText(p) : null);
  const diagnostics: Diagnostic[] = [];
  const allTokens = [];
  const cFiles = Object.keys(files).filter((n) => n.endsWith('.c')).sort((a, b) => (a === 'main.c' ? -1 : b === 'main.c' ? 1 : a.localeCompare(b)));
  for (const name of cFiles) {
    const path = '/home/' + name;
    const { tokens, diagnostics: pp } = preprocess(files[name]!, { file: path, systemDirs: SYSTEM_INCLUDE_DIRS, readFile });
    diagnostics.push(...pp);
    for (const t of tokens) if (t.kind !== 'eof') allTokens.push(t);
  }
  allTokens.push({ kind: 'eof' as const, value: '', span: zero(), atBol: true, spaceBefore: false });
  const { unit, diagnostics: pd } = parse(allTokens);
  diagnostics.push(...pd);
  const sema = analyze(unit);
  diagnostics.push(...sema.diagnostics);

  const con = new Console();
  if (stdin) con.feed(stdin);
  con.closeInput();
  const mem = new Memory();
  const sys = new Syscalls(vfs, con);
  return { unit, sema, diagnostics, con, mem, sys, vfs };
}

export interface ExecOptions {
  stdin?: string;
  argv?: string[];
  trace?: boolean;
}

export function execute(files: Record<string, string>, opts: ExecOptions = {}): Outcome {
  const { unit, sema, diagnostics, con, mem, sys, vfs } = buildMachine(files, opts.stdin ?? '');
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const base: Outcome = {
    diagnostics,
    stdout: '',
    stderr: '',
    faults: [],
    leaks: [],
    segments: segViews(mem),
    globals: [],
    heap: [],
    snapshots: [],
    truncated: false,
    mem,
  };
  if (errors.length > 0) return base;

  const snapshots: Snapshot[] = [];
  let truncated = false;
  let dbg: Debugger | undefined;
  if (opts.trace) {
    dbg = new Debugger();
    dbg.pauseNext();
    dbg.onPause = (d, ev: StopEvent, interp: Interp) => {
      if (snapshots.length < MAX_SNAPSHOTS) {
        snapshots.push({
          step: snapshots.length,
          line: ev.line,
          file: ev.file,
          func: ev.func,
          depth: ev.depth,
          callStack: ev.callStack,
          locals: ev.locals,
          globals: interp.globalVars(),
          heap: interp.mem.heapList(),
          segments: segViews(interp.mem),
          outLen: interp.con.stdout().length,
          errLen: interp.con.stderr().length,
        });
      } else {
        truncated = true;
      }
      d.stepIn(); // record every statement
    };
  }

  let finalGlobals: VarView[] = [];
  const result = run(unit, sema, {
    console: con,
    memory: mem,
    syscalls: sys,
    vfs,
    natives: createLibc(),
    argv: opts.argv,
    debug: dbg,
    onFinish: (interp) => {
      finalGlobals = interp.globalVars();
    },
  });

  return {
    diagnostics,
    stdout: con.stdout(),
    stderr: con.stderr(),
    exitCode: result.exitCode,
    faults: [...(result.fatal ? [result.fatal] : []), ...result.faults].map((f) => ({ kind: f.kind, addr: f.addr, message: f.message })),
    leaks: result.leaks.map((l) => ({ addr: l.addr, size: l.size, freed: false })),
    segments: segViews(mem),
    globals: finalGlobals,
    heap: mem.heapList(),
    snapshots,
    truncated,
    mem,
  };
}

function zero() {
  const p = { file: '<link>', line: 1, col: 1, offset: 0 };
  return { start: p, end: p };
}

export function readMemoryBytes(_files: Record<string, string>): Uint8Array {
  return new Uint8Array(0);
}

export const STDLIB_HEADERS = standardHeaders();
