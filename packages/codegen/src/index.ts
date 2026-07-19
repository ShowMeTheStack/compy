import { Module } from '@compy/ir';
import { select } from './isel';
import { allocate, AllocStrategy, AllocReport } from './regalloc';
import { formatAsm, formatFunc } from './asm';
import { MModule, fmtMFunc } from './mir';

export * from './mir';
export * from './isel';
export * from './regalloc';
export * from './asm';
export * from './sim';

export interface CodegenOptions {
  strategy?: AllocStrategy;
  /** Source lines for the listing's `# line N:` comments. */
  source?: string[];
}

export interface CodegenResult {
  /** Machine code with physical registers (what the simulator runs). */
  mmod: MModule;
  /** The listing before register allocation (virtual registers). */
  preRA: string;
  /** Final assembly listing. */
  asm: string;
  reports: AllocReport[];
}

/** IR → machine code: instruction selection, register allocation, frame layout. */
export function codegen(ir: Module, opts: CodegenOptions = {}): CodegenResult {
  const strategy = opts.strategy ?? 'linear-scan';
  const mmod = select(ir);
  const preRA = mmod.functions.map((f) => fmtMFunc(f)).join('\n\n');
  const reports = mmod.functions.map((f) => allocate(f, strategy));
  return { mmod, preRA, asm: formatAsm(mmod, ir, opts.source), reports };
}

export { formatFunc };
