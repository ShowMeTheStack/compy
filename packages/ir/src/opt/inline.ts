import { Module, Func, Block, Instr, Reg, Value, Const, instrCount, defOf, mapUses, cloneFunc, isTerminator } from '../ir';
import { maxRegId } from './analysis';

/**
 * Function inlining: a call to a small function is replaced by a copy of its
 * body. The callee's blocks are cloned with fresh register and block names,
 * its parameters become the argument values, and its returns branch to a
 * continuation block where a phi collects the return value.
 */
export interface InlineOptions {
  /** Callees with more instructions than this are left alone. */
  maxCalleeSize?: number;
}

export function inlineCalls(m: Module, opts: InlineOptions = {}): number {
  const maxSize = opts.maxCalleeSize ?? 40;
  const byName = new Map<string, Func>();
  for (const f of m.functions) byName.set(f.name, f);
  let count = 0;
  for (const caller of m.functions) {
    for (let round = 0; round < 4; round++) {
      let didInline = false;
      for (const b of caller.blocks.slice()) {
        for (let idx = 0; idx < b.instrs.length; idx++) {
          const i = b.instrs[idx]!;
          if (i.op !== 'call' || typeof i.callee !== 'string') continue;
          const callee = byName.get(i.callee);
          if (!callee || callee === caller || !inlinable(callee, maxSize)) continue;
          if (callee.params.length !== i.args.length) continue;
          inlineOne(caller, b, idx, i, callee);
          count++;
          didInline = true;
          break;
        }
        if (didInline) break;
      }
      if (!didInline) break;
    }
  }
  return count;
}

function inlinable(f: Func, maxSize: number): boolean {
  if (f.variadic || f.name === 'main') return false;
  if (instrCount(f) > maxSize) return false;
  for (const b of f.blocks) for (const i of b.instrs) {
    if (i.op === 'call' && i.callee === f.name) return false; // directly recursive
    if (i.op === 'alloca' && i.size.kind !== 'const') return false; // VLAs
  }
  return true;
}

function inlineOne(caller: Func, b: Block, idx: number, call: Extract<Instr, { op: 'call' }>, callee: Func): void {
  const copy = cloneFunc(callee);
  let nextId = maxRegId(caller) + 1;
  const regMap = new Map<number, Value>();
  copy.params.forEach((p, k) => regMap.set(p.id, call.args[k]!));
  const fresh = (r: Reg): Reg => {
    const existing = regMap.get(r.id);
    if (existing && existing.kind === 'reg') return existing;
    const n: Reg = { kind: 'reg', id: nextId++, type: r.type, name: r.name };
    regMap.set(r.id, n);
    return n;
  };
  // Fresh block names.
  const suffix = `.inl${call.line ?? ''}.${nextId}`;
  const blockMap = new Map<string, string>();
  for (const cb of copy.blocks) blockMap.set(cb.name, `${callee.name}.${cb.name}${suffix}`);
  const contName = `${b.name}.cont${suffix}`;
  const cont: Block = { name: contName, instrs: b.instrs.slice(idx + 1) };
  const retVals: { value: Value; block: string }[] = [];
  const allocas: Instr[] = [];

  // Pass 1: fresh names for every definition (uses may precede defs in loops).
  for (const cb of copy.blocks) for (const i of cb.instrs) {
    const d = defOf(i);
    if (d) (i as { dst: Reg }).dst = fresh(d);
  }
  const newBlocks: Block[] = [];
  for (const cb of copy.blocks) {
    const nb: Block = { name: blockMap.get(cb.name)!, instrs: [] };
    for (const i of cb.instrs) {
      mapUses(i, (v) => (v.kind === 'reg' ? regMap.get(v.id) ?? v : v));
      if (i.op === 'phi') for (const inc of i.incoming) inc.block = blockMap.get(inc.block) ?? inc.block;
      if (i.op === 'br') i.target = blockMap.get(i.target)!;
      else if (i.op === 'condbr') {
        i.then = blockMap.get(i.then)!;
        i.else = blockMap.get(i.else)!;
      } else if (i.op === 'switch') {
        i.default = blockMap.get(i.default)!;
        for (const c of i.cases) c.target = blockMap.get(c.target)!;
      } else if (i.op === 'ret') {
        if (i.val) retVals.push({ value: i.val, block: nb.name });
        nb.instrs.push({ op: 'br', target: contName, line: call.line });
        continue;
      } else if (i.op === 'alloca' && cb === copy.blocks[0] && i.size.kind === 'const') {
        allocas.push(i);
        continue;
      }
      if (i.line === undefined) i.line = call.line;
      nb.instrs.push(i);
    }
    newBlocks.push(nb);
  }
  // The call site: everything before the call stays, then jump into the callee.
  b.instrs = b.instrs.slice(0, idx);
  b.instrs.push({ op: 'br', target: newBlocks[0]!.name, line: call.line });
  // Return value phi.
  if (call.dst) {
    if (retVals.length === 1) {
      const rv = retVals[0]!.value;
      for (const blk of [cont, ...caller.blocks]) for (const i of blk.instrs) mapUses(i, (v) => (v.kind === 'reg' && v.id === call.dst!.id ? rv : v));
    } else if (retVals.length > 1) {
      cont.instrs.unshift({ op: 'phi', dst: call.dst, incoming: retVals, line: call.line });
    } else {
      const zero: Const = { kind: 'const', type: call.dst.type, i: 0n, f: 0 };
      for (const blk of [cont, ...caller.blocks]) for (const i of blk.instrs) mapUses(i, (v) => (v.kind === 'reg' && v.id === call.dst!.id ? zero : v));
    }
  }
  // Phis in blocks that followed `b` now come from `cont`.
  const last = cont.instrs[cont.instrs.length - 1];
  if (last && isTerminator(last)) {
    for (const blk of caller.blocks) {
      for (const i of blk.instrs) {
        if (i.op !== 'phi') break;
        for (const inc of i.incoming) if (inc.block === b.name) inc.block = contName;
      }
    }
  }
  // Static allocas of the callee move to the caller's entry block.
  const entry = caller.blocks[0]!;
  let insertAt = 0;
  while (insertAt < entry.instrs.length && entry.instrs[insertAt]!.op === 'alloca') insertAt++;
  entry.instrs.splice(insertAt, 0, ...allocas);
  const at = caller.blocks.indexOf(b);
  caller.blocks.splice(at + 1, 0, ...newBlocks, cont);
}
