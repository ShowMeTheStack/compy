import {
  lex, preprocess, parse, analyze, Diagnostic, SemaResult, TranslationUnit, PPEvent, DefLink, Token,
} from '@compy/cc';
import { run, Interp, Debugger, StopEvent, VarView } from '@compy/vm';
import { Memory, Console, Syscalls, SegmentName, Segment } from '@compy/runtime';
import { setupVfs, createLibc, standardHeaders, SYSTEM_INCLUDE_DIRS } from '@compy/libc';
import { lower, optimize, runIr, Module, OptimizeResult, PassId, DEFAULT_PASSES, fmtModule, IrStepEvent, RVal } from '@compy/ir';
import { codegen, CodegenResult, Simulator, AllocStrategy, SimStepEvent } from '@compy/codegen';

/**
 * The IDE's orchestration layer. `analyzeProject` runs the whole compiler
 * over the project and exposes every intermediate result (tokens, the
 * preprocessed stream, the AST, types, IR, the optimization log, assembly)
 * for the phase panels. `execute` runs the program on one of the three
 * engines — the AST interpreter, the IR interpreter, or the RISC-V
 * simulator — recording per-line snapshots for time-travel debugging and,
 * for the lower-level engines, an instruction trace for the steppers.
 */

export type Engine = 'ast' | 'ir' | 'machine';

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
  /** Index into the instruction trace (IR / machine engines). */
  traceIndex?: number;
}

export interface IrTraceEntry {
  fn: string;
  block: string;
  index: number;
  text: string;
  line?: number;
  depth: number;
  regs: [number, string][];
}
export interface MachTraceEntry {
  pc: number;
  index: number;
  text: string;
  fn: string;
  line?: number;
  depth: number;
  x: Int32Array;
  f: Float64Array;
}

export interface Outcome {
  engine: Engine;
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
  mem: Memory;
  irTrace: IrTraceEntry[];
  machTrace: MachTraceEntry[];
  steps: number;
}

export interface CompileSettings {
  passes: PassId[];
  strategy: AllocStrategy;
}
export const DEFAULT_SETTINGS: CompileSettings = { passes: DEFAULT_PASSES, strategy: 'linear-scan' };

export interface AnalyzeResult {
  diagnostics: Diagnostic[];
  unit: TranslationUnit;
  sema: SemaResult;
  defs: DefLink[];
  lens: PPEvent[];
  /** Raw tokens of the active file (translation phases 1–3). */
  tokens: Token[];
  /** The active file after preprocessing (phase 4). */
  ppTokens: Token[];
  /** The active file parsed on its own (for the AST and types panels). */
  activeUnit: TranslationUnit;
  activeSema: SemaResult;
  ir: Module | null;
  irText: string;
  opt: OptimizeResult | null;
  optText: string;
  cg: CodegenResult | null;
  cgError: string | null;
}

const MAX_SNAPSHOTS = 20000;
const MAX_TRACE = 8000;

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

function linkUnit(files: Record<string, string>, vfs: ReturnType<typeof setupVfs>, diagnostics: Diagnostic[]) {
  const readFile = (p: string): string | null => (vfs.isFile(p) ? vfs.readText(p) : null);
  const allTokens: Token[] = [];
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
  return { unit, sema };
}

/** Run every phase of the compiler over the project for the phase panels. */
export function analyzeProject(files: Record<string, string>, activeFile: string, settings: CompileSettings = DEFAULT_SETTINGS): AnalyzeResult {
  const vfs = setupVfs(files);
  const readFile = (p: string): string | null => (vfs.isFile(p) ? vfs.readText(p) : null);
  const lens: PPEvent[] = [];
  const diagnostics: Diagnostic[] = [];
  const activePath = activeFile.startsWith('/') ? activeFile : '/home/' + activeFile;
  const activeSrc = files[activeFile] ?? '';

  // Phase 1–3: raw tokens of the active file.
  const tokens = lex(activeSrc, activePath).tokens;
  // Phase 4: preprocess the active file with lens capture.
  let ppTokens: Token[] = [];
  if (files[activeFile] !== undefined) {
    const r = preprocess(activeSrc, { file: activePath, systemDirs: SYSTEM_INCLUDE_DIRS, readFile, onEvent: (e) => lens.push(e) });
    diagnostics.push(...r.diagnostics);
    ppTokens = r.tokens;
  }
  // Phases 7–8 for the active file alone (AST / types panels).
  const activeParse = parse(ppTokens.length ? ppTokens : [{ kind: 'eof', value: '', span: zero(), atBol: true, spaceBefore: false }]);
  const activeSema = analyze(activeParse.unit);

  // The full link for diagnostics, go-to-def, and everything downstream.
  const { unit, sema } = linkUnit(files, vfs, diagnostics);
  const hasErrors = diagnostics.some((d) => d.severity === 'error');

  let ir: Module | null = null;
  let irText = '';
  let opt: OptimizeResult | null = null;
  let optText = '';
  let cg: CodegenResult | null = null;
  let cgError: string | null = null;
  if (!hasErrors) {
    try {
      const l = lower(unit, sema);
      diagnostics.push(...l.diagnostics);
      if (!l.diagnostics.some((d) => d.severity === 'error')) {
        ir = l.module;
        irText = fmtModule(ir);
        opt = optimize(ir, settings.passes);
        optText = fmtModule(opt.module);
        cg = codegen(opt.module, { strategy: settings.strategy, source: activeSrc.split('\n') });
      }
    } catch (e) {
      cgError = e instanceof Error ? e.message : String(e);
    }
  }
  return { diagnostics, unit, sema, defs: sema.defs, lens, tokens, ppTokens, activeUnit: activeParse.unit, activeSema, ir, irText, opt, optText, cg, cgError };
}

export interface ExecOptions {
  stdin?: string;
  argv?: string[];
  trace?: boolean;
  engine?: Engine;
  settings?: CompileSettings;
  /** Run the optimized IR / code (default true for ir/machine). */
  optimized?: boolean;
}

export function execute(files: Record<string, string>, opts: ExecOptions = {}): Outcome {
  const engine = opts.engine ?? 'ast';
  const vfs = setupVfs(files);
  const diagnostics: Diagnostic[] = [];
  const { unit, sema } = linkUnit(files, vfs, diagnostics);
  const con = new Console();
  if (opts.stdin) con.feed(opts.stdin);
  con.closeInput();
  const mem = new Memory();
  const sys = new Syscalls(vfs, con);
  const base: Outcome = {
    engine,
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
    irTrace: [],
    machTrace: [],
    steps: 0,
  };
  if (diagnostics.some((d) => d.severity === 'error')) return base;

  const snapshots: Snapshot[] = [];
  let truncated = false;
  const irTrace: IrTraceEntry[] = [];
  const machTrace: MachTraceEntry[] = [];
  const snap = (line: number, file: string, depth: number, callStack: { name: string; line: number }[], locals: VarView[], globals: VarView[], m: Memory, traceIndex?: number) => {
    if (snapshots.length >= MAX_SNAPSHOTS) {
      truncated = true;
      return;
    }
    snapshots.push({
      step: snapshots.length,
      line,
      file,
      func: callStack[callStack.length - 1]?.name ?? '',
      depth,
      callStack,
      locals,
      globals,
      heap: m.heapList(),
      segments: segViews(m),
      outLen: con.stdout().length,
      errLen: con.stderr().length,
      traceIndex,
    });
  };

  let exitCode = 0;
  let faults: { kind: string; addr: number; message: string }[] = [];
  let leaks: HeapView[] = [];
  let finalGlobals: VarView[] = [];
  let steps = 0;
  const mainFile = '/home/' + (Object.keys(files).find((n) => n === 'main.c') ?? Object.keys(files).find((n) => n.endsWith('.c')) ?? 'main.c');

  if (engine === 'ast') {
    let dbg: Debugger | undefined;
    if (opts.trace) {
      dbg = new Debugger();
      dbg.pauseNext();
      dbg.onPause = (d, ev: StopEvent, interp: Interp) => {
        snap(ev.line, ev.file, ev.depth, ev.callStack, ev.locals, interp.globalVars(), interp.mem);
        d.stepIn();
      };
    }
    const result = run(unit, sema, { console: con, memory: mem, syscalls: sys, vfs, natives: createLibc(), argv: opts.argv, debug: dbg, onFinish: (i) => { finalGlobals = i.globalVars(); } });
    exitCode = result.exitCode;
    faults = [...(result.fatal ? [result.fatal] : []), ...result.faults].map((f) => ({ kind: f.kind, addr: f.addr, message: f.message }));
    leaks = result.leaks.map((l) => ({ addr: l.addr, size: l.size, freed: false }));
  } else {
    const l = lower(unit, sema);
    diagnostics.push(...l.diagnostics);
    if (l.diagnostics.some((d) => d.severity === 'error')) return { ...base, diagnostics };
    const settings = opts.settings ?? DEFAULT_SETTINGS;
    const mod = opts.optimized === false ? l.module : optimize(l.module, settings.passes).module;
    if (engine === 'ir') {
      const result = runIr(mod, {
        console: con, memory: mem, syscalls: sys, vfs, natives: createLibc(), argv: opts.argv,
        onInstr: opts.trace ? (ev: IrStepEvent) => {
          if (irTrace.length < MAX_TRACE) irTrace.push({ fn: ev.fn, block: ev.block, index: ev.index, text: ev.text, line: ev.line, depth: ev.depth, regs: [...ev.regs].map(([id, v]) => [id, fmtRVal(v)] as [number, string]) });
        } : undefined,
        onLine: opts.trace ? (line, interp) => snap(line, mainFile, interp.callDepth(), interp.callStack(), interp.frameVars(), interp.globalVars(), interp.mem, irTrace.length - 1) : undefined,
        onFinish: (i) => { finalGlobals = i.globalVars(); },
      });
      exitCode = result.exitCode;
      steps = result.steps;
      faults = [...(result.fatal ? [result.fatal] : []), ...result.faults].map((f) => ({ kind: f.kind, addr: f.addr, message: f.message }));
      leaks = result.leaks.map((x) => ({ addr: x.addr, size: x.size, freed: false }));
    } else {
      const cg = codegen(mod, { strategy: settings.strategy });
      const sim = new Simulator(cg.mmod, mod, {
        console: con, memory: mem, syscalls: sys, vfs, natives: createLibc(), argv: opts.argv,
        onStep: opts.trace ? (ev: SimStepEvent, s) => {
          if (machTrace.length < MAX_TRACE) machTrace.push({ pc: ev.pc, index: ev.index, text: ev.text, fn: ev.fn, line: ev.line, depth: ev.depth, x: Int32Array.from(s.x), f: Float64Array.from(s.f) });
        } : undefined,
        onLine: opts.trace ? (line, s) => snap(line, mainFile, s.callDepth(), s.callStack(), s.frameVars(), s.globalVars(), s.mem, machTrace.length) : undefined,
        onFinish: (s) => { finalGlobals = s.globalVars(); },
      });
      const result = sim.run();
      exitCode = result.exitCode;
      steps = result.steps;
      faults = [...(result.fatal ? [result.fatal] : []), ...result.faults].map((f) => ({ kind: f.kind, addr: f.addr, message: f.message }));
      leaks = result.leaks.map((x) => ({ addr: x.addr, size: x.size, freed: false }));
    }
  }

  return {
    engine,
    diagnostics,
    stdout: con.stdout(),
    stderr: con.stderr(),
    exitCode,
    faults,
    leaks,
    segments: segViews(mem),
    globals: finalGlobals,
    heap: mem.heapList(),
    snapshots,
    truncated,
    mem,
    irTrace,
    machTrace,
    steps,
  };
}

function fmtRVal(v: RVal): string {
  return typeof v === 'bigint' ? v.toString() : Number.isInteger(v) ? v.toFixed(1) : String(v);
}

function zero() {
  const p = { file: '<link>', line: 1, col: 1, offset: 0 };
  return { start: p, end: p };
}

export const STDLIB_HEADERS = standardHeaders();
