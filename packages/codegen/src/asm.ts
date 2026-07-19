import { Module } from '@compy/ir';
import { MModule, MFunc, fmtMInstr } from './mir';

/**
 * Pretty assembly listing in GNU as syntax: data and rodata sections from
 * the IR module's globals and strings, then the text section with one
 * label per basic block and the source line of each instruction group as
 * a comment, so the listing can be read side by side with the C.
 */
export function formatAsm(m: MModule, ir: Module, source?: string[]): string {
  const out: string[] = [];
  out.push('    .section .rodata');
  ir.strings.forEach((s, k) => out.push(`.str${k}:`, `    .asciz "${escapeBytes(s)}"`));
  for (const fc of m.floatConsts) {
    out.push(`${fc.label}:`);
    const dv = new DataView(new ArrayBuffer(8));
    if (fc.bits === 32) {
      dv.setFloat32(0, fc.value, true);
      out.push(`    .word 0x${dv.getUint32(0, true).toString(16).padStart(8, '0')}        # float ${fc.value}`);
    } else {
      dv.setFloat64(0, fc.value, true);
      out.push(`    .word 0x${dv.getUint32(0, true).toString(16).padStart(8, '0')}, 0x${dv.getUint32(4, true).toString(16).padStart(8, '0')}  # double ${fc.value}`);
    }
  }
  for (const g of ir.globals.filter((g) => g.readonly && g.init)) emitGlobal(out, g.name, g.init!, g.ctype, g.relocs);
  const data = ir.globals.filter((g) => !g.readonly && g.init);
  if (data.length) {
    out.push('', '    .section .data');
    for (const g of data) emitGlobal(out, g.name, g.init!, g.ctype, g.relocs);
  }
  const bss = ir.globals.filter((g) => !g.init);
  if (bss.length) {
    out.push('', '    .section .bss');
    for (const g of bss) out.push(`${g.name}:`, `    .zero ${g.size}        # ${g.ctype}`);
  }
  out.push('', '    .section .text');
  for (const f of m.functions) {
    out.push('', `    .globl ${f.name}`, `# ${f.csig}`);
    out.push(...formatFunc(f, source));
  }
  return out.join('\n') + '\n';
}

export function formatFunc(f: MFunc, source?: string[]): string[] {
  const out: string[] = [];
  let lastLine = -1;
  for (const b of f.blocks) {
    out.push(`${b.name}:`);
    b.instrs.forEach((i, k) => {
      if (i.line !== undefined && i.line !== lastLine && source) {
        lastLine = i.line;
        const text = (source[i.line - 1] ?? '').trim();
        if (text) out.push(`    # line ${i.line}: ${text}`);
      }
      // Drop a jump to the block that immediately follows (fallthrough).
      const nextBlock = f.blocks[f.blocks.indexOf(b) + 1];
      if (i.op === 'j' && k === b.instrs.length - 1 && nextBlock && i.target === nextBlock.name) return;
      out.push('    ' + fmtMInstr(i));
    });
  }
  return out;
}

function emitGlobal(out: string[], name: string, init: Uint8Array, ctype: string, relocs: { offset: number; kind: string; ref: string | number; addend: number }[]): void {
  out.push(`${name}:        # ${ctype}`);
  let k = 0;
  const relocAt = new Map(relocs.map((r) => [r.offset, r] as const));
  while (k < init.length) {
    const r = relocAt.get(k);
    if (r && k + 4 <= init.length) {
      const sym = r.kind === 'str' ? `.str${r.ref}` : String(r.ref);
      out.push(`    .word ${sym}${r.addend ? '+' + r.addend : ''}`);
      k += 4;
      continue;
    }
    if (k + 4 <= init.length && k % 4 === 0 && !hasRelocIn(relocAt, k, 4)) {
      const dv = new DataView(init.buffer, init.byteOffset + k, 4);
      out.push(`    .word ${dv.getInt32(0, true)}`);
      k += 4;
      continue;
    }
    out.push(`    .byte ${init[k]}`);
    k++;
  }
}
function hasRelocIn(m: Map<number, unknown>, from: number, len: number): boolean {
  for (let k = from; k < from + len; k++) if (m.has(k)) return true;
  return false;
}

function escapeBytes(b: Uint8Array): string {
  let s = '';
  for (let k = 0; k < b.length; k++) {
    const c = b[k]!;
    if (c === 0 && k === b.length - 1) break;
    if (c === 10) s += '\\n';
    else if (c === 9) s += '\\t';
    else if (c === 34) s += '\\"';
    else if (c === 92) s += '\\\\';
    else if (c >= 32 && c < 127) s += String.fromCharCode(c);
    else s += '\\' + c.toString(8).padStart(3, '0');
  }
  return s;
}
