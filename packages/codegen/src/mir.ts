import type { Sig } from '@compy/ir';

/**
 * Machine IR for the RV32IMFD target. Instructions use real RISC-V
 * mnemonics and ABI register names; before register allocation operands may
 * be virtual registers (`v12`, `fv3`), which the allocator replaces with
 * physical ones or spill code.
 */
export type MReg = string;

export interface MInstr {
  op: string;
  rd?: MReg;
  rs1?: MReg;
  rs2?: MReg;
  imm?: number;
  /** Branch/jump label, call symbol, or `la` symbol. */
  target?: string;
  /** Call signature (needed by the simulator's native bridge). */
  sig?: Sig;
  line?: number;
  comment?: string;
  /** Group id of a call sequence (argument setup … result copy). */
  callSeq?: number;
  /** For `addi rd, s0, <slot>`: resolved to the slot's frame offset. */
  frameSlot?: string;
  /** For loads of stack-passed parameters: resolved to fp-relative offset. */
  stackParam?: number;
  /** Set when this instruction is a call: used by the allocator. */
  isCall?: boolean;
}

export interface MBlock {
  name: string;
  instrs: MInstr[];
}

export interface AllocaSlot {
  name: string;
  size: number;
  align: number;
  ctype: string;
}

export interface MFunc {
  name: string;
  blocks: MBlock[];
  /** Virtual register classes. */
  vregs: Map<MReg, 'int' | 'float'>;
  allocas: AllocaSlot[];
  /** Largest outgoing stack-argument area needed by any call. */
  outgoingArgBytes: number;
  hasDynamicAlloca: boolean;
  line?: number;
  csig: string;
}

export interface FloatConst {
  label: string;
  bits: number;
  value: number;
}

export interface MModule {
  functions: MFunc[];
  floatConsts: FloatConst[];
}

// -- register sets -------------------------------------------------------------

export const INT_REGS = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
  's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
];
export const FLOAT_REGS = [
  'ft0', 'ft1', 'ft2', 'ft3', 'ft4', 'ft5', 'ft6', 'ft7', 'fs0', 'fs1', 'fa0', 'fa1', 'fa2', 'fa3', 'fa4', 'fa5', 'fa6', 'fa7',
  'fs2', 'fs3', 'fs4', 'fs5', 'fs6', 'fs7', 'fs8', 'fs9', 'fs10', 'fs11', 'ft8', 'ft9', 'ft10', 'ft11',
];
export const ARG_REGS = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
export const FARG_REGS = ['fa0', 'fa1', 'fa2', 'fa3', 'fa4', 'fa5', 'fa6', 'fa7'];
/** Caller-saved (clobbered by calls). t5/t6 and ft10/ft11 are reserved as spill scratch. */
export const CALLER_SAVED_INT = ['t0', 't1', 't2', 't3', 't4', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
export const CALLEE_SAVED_INT = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'];
export const CALLER_SAVED_FLOAT = ['ft0', 'ft1', 'ft2', 'ft3', 'ft4', 'ft5', 'ft6', 'ft7', 'ft8', 'ft9', 'fa0', 'fa1', 'fa2', 'fa3', 'fa4', 'fa5', 'fa6', 'fa7'];
export const CALLEE_SAVED_FLOAT = ['fs0', 'fs1', 'fs2', 'fs3', 'fs4', 'fs5', 'fs6', 'fs7', 'fs8', 'fs9', 'fs10', 'fs11'];
export const SCRATCH_INT = ['t5', 't6'];
export const SCRATCH_FLOAT = ['ft10', 'ft11'];

export function isVirtual(r: MReg | undefined): r is MReg {
  return !!r && (r.startsWith('v') || r.startsWith('fv'));
}
export function isFloatReg(r: MReg): boolean {
  return r.startsWith('f');
}
export function isPhysical(r: MReg | undefined): boolean {
  return !!r && !isVirtual(r);
}

// -- instruction shapes ----------------------------------------------------------

const LOADS = new Set(['lw', 'lh', 'lhu', 'lb', 'lbu', 'flw', 'fld']);
const STORES = new Set(['sw', 'sh', 'sb', 'fsw', 'fsd']);
const BRANCH2 = new Set(['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu']);
const BRANCH1 = new Set(['beqz', 'bnez']);

export function isLoad(op: string): boolean {
  return LOADS.has(op);
}
export function isStore(op: string): boolean {
  return STORES.has(op);
}
export function isBranch(op: string): boolean {
  return BRANCH2.has(op) || BRANCH1.has(op) || op === 'j';
}

/** Registers read by an instruction. */
export function readsOf(i: MInstr): MReg[] {
  const out: MReg[] = [];
  if (isStore(i.op)) {
    if (i.rs2) out.push(i.rs2);
    if (i.rs1) out.push(i.rs1);
    return out;
  }
  if (i.rs1) out.push(i.rs1);
  if (i.rs2) out.push(i.rs2);
  return out;
}
/** Register written by an instruction (none for stores/branches). */
export function writeOf(i: MInstr): MReg | undefined {
  if (isStore(i.op) || isBranch(i.op) || i.op === 'ret' || i.op === 'call' || i.op === 'jalr') return undefined;
  return i.rd;
}

export function fmtMInstr(i: MInstr): string {
  const { op } = i;
  let text: string;
  if (isLoad(op)) text = `${op} ${i.rd}, ${i.imm ?? 0}(${i.rs1})`;
  else if (isStore(op)) text = `${op} ${i.rs2}, ${i.imm ?? 0}(${i.rs1})`;
  else if (BRANCH2.has(op)) text = `${op} ${i.rs1}, ${i.rs2}, ${i.target}`;
  else if (BRANCH1.has(op)) text = `${op} ${i.rs1}, ${i.target}`;
  else if (op === 'j' || op === 'call') text = `${op} ${i.target}`;
  else if (op === 'jalr') text = `jalr ${i.rs1}`;
  else if (op === 'ret' || op === 'nop') text = op;
  else if (op === 'li' || op === 'lui') text = `${op} ${i.rd}, ${i.imm}`;
  else if (op === 'la') text = `la ${i.rd}, ${i.target}`;
  else if (op === 'label') text = `${i.target}:`;
  else if (i.rs2 !== undefined) text = `${op} ${i.rd}, ${i.rs1}, ${i.rs2}`;
  else if (i.imm !== undefined && i.rs1 !== undefined) text = `${op} ${i.rd}, ${i.rs1}, ${i.imm}`;
  else if (i.rs1 !== undefined) text = `${op} ${i.rd}, ${i.rs1}`;
  else text = `${op} ${i.rd ?? ''}`;
  return i.comment ? `${text.padEnd(28)} # ${i.comment}` : text;
}

export function fmtMFunc(f: MFunc): string {
  const lines = [`${f.name}:`];
  for (const b of f.blocks) {
    if (b !== f.blocks[0]) lines.push(`${b.name}:`);
    for (const i of b.instrs) lines.push('    ' + fmtMInstr(i));
  }
  return lines.join('\n');
}
