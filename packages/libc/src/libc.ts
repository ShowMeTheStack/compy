import * as T from '@cide/cc';
import { Interp, Val, NativeFn, intVal, floatVal, ptrVal } from '@cide/vm';
import { formatPrintf } from './format';

/**
 * A from-scratch C89 standard library implemented as native functions over the
 * interpreter's memory, console, and syscalls. This is the M5 starter set
 * (stdio core, stdlib, string, math); M6 completes it (FILE streams, the full
 * stdio family over the VFS, ctype, time, assert, setjmp, errno).
 */

const VOIDP = T.pointerTo(T.VOID);
const CHARP = T.pointerTo(T.CHAR);

function argInt(a: Val[], i: number): number {
  return Number(a[i]?.i ?? 0n);
}
function argFloat(a: Val[], i: number): number {
  const v = a[i];
  if (!v) return 0;
  return v.type.kind === 'float' ? v.f : Number(v.i);
}

export function createLibc(): Record<string, NativeFn> {
  let randState = 1;

  const lib: Record<string, NativeFn> = {
    // -- stdio ---------------------------------------------------------------
    putchar(ctx, a) {
      const c = argInt(a, 0) & 0xff;
      ctx.sys.write(1, new Uint8Array([c]));
      return intVal(T.INT, BigInt(c));
    },
    puts(ctx, a) {
      const s = ctx.readCString(argInt(a, 0));
      ctx.sys.write(1, new TextEncoder().encode(s + '\n'));
      return intVal(T.INT, BigInt(s.length + 1));
    },
    printf(ctx, a) {
      const fmt = ctx.readCString(argInt(a, 0));
      const out = formatPrintf(ctx, fmt, a, 1);
      ctx.sys.write(1, new TextEncoder().encode(out));
      return intVal(T.INT, BigInt(out.length));
    },
    fprintf(ctx, a) {
      // args: (FILE* stream, fmt, ...). We map stdout/stderr sentinels to fds.
      const stream = argInt(a, 0);
      const fd = stream === 2 ? 2 : 1;
      const fmt = ctx.readCString(argInt(a, 1));
      const out = formatPrintf(ctx, fmt, a, 2);
      ctx.sys.write(fd, new TextEncoder().encode(out));
      return intVal(T.INT, BigInt(out.length));
    },
    sprintf(ctx, a) {
      const dst = argInt(a, 0);
      const fmt = ctx.readCString(argInt(a, 1));
      const out = formatPrintf(ctx, fmt, a, 2);
      writeCString(ctx, dst, out);
      return intVal(T.INT, BigInt(out.length));
    },
    snprintf(ctx, a) {
      const dst = argInt(a, 0);
      const n = argInt(a, 1);
      const fmt = ctx.readCString(argInt(a, 2));
      const out = formatPrintf(ctx, fmt, a, 3);
      if (n > 0) {
        const truncated = out.slice(0, n - 1);
        writeCString(ctx, dst, truncated);
      }
      return intVal(T.INT, BigInt(out.length));
    },

    // -- stdlib: memory ------------------------------------------------------
    malloc(ctx, a) {
      return ptrVal(VOIDP, ctx.mem.malloc(argInt(a, 0)));
    },
    calloc(ctx, a) {
      return ptrVal(VOIDP, ctx.mem.calloc(argInt(a, 0), argInt(a, 1)));
    },
    realloc(ctx, a) {
      const old = argInt(a, 0);
      const size = argInt(a, 1);
      if (old === 0) return ptrVal(VOIDP, ctx.mem.malloc(size));
      const block = ctx.mem.heapList().find((b) => b.addr === old && !b.freed);
      const next = ctx.mem.malloc(size);
      if (next && block) ctx.mem.copy(next, old, Math.min(block.size, size));
      if (block) ctx.mem.free(old);
      return ptrVal(VOIDP, next);
    },
    free(ctx, a) {
      ctx.mem.free(argInt(a, 0));
      return null;
    },

    // -- stdlib: process -----------------------------------------------------
    exit(ctx, a) {
      return ctx.exit(argInt(a, 0));
    },
    abort(ctx) {
      ctx.con.write('err', 'abort\n');
      return ctx.exit(134);
    },
    atexit(ctx, a) {
      ctx.registerAtexit(argInt(a, 0));
      return intVal(T.INT, 0n);
    },

    // -- stdlib: conversions -------------------------------------------------
    atoi(ctx, a) {
      return intVal(T.INT, BigInt(parseCInt(ctx.readCString(argInt(a, 0)))));
    },
    atol(ctx, a) {
      return intVal(T.LONG, BigInt(parseCInt(ctx.readCString(argInt(a, 0)))));
    },
    atof(ctx, a) {
      return floatVal(T.DOUBLE, parseFloat(ctx.readCString(argInt(a, 0)).trim()) || 0);
    },
    abs(_ctx, a) {
      const v = BigInt(argInt(a, 0));
      return intVal(T.INT, v < 0n ? -v : v);
    },
    labs(_ctx, a) {
      const v = BigInt(argInt(a, 0));
      return intVal(T.LONG, v < 0n ? -v : v);
    },

    // -- stdlib: random ------------------------------------------------------
    rand(_ctx) {
      randState = (randState * 1103515245 + 12345) & 0x7fffffff;
      return intVal(T.INT, BigInt(randState));
    },
    srand(_ctx, a) {
      randState = argInt(a, 0) >>> 0;
      return null;
    },

    // -- stdlib: qsort / bsearch --------------------------------------------
    qsort(ctx, a) {
      const base = argInt(a, 0);
      const n = argInt(a, 1);
      const size = argInt(a, 2);
      const cmp = argInt(a, 3);
      if (n <= 1 || size <= 0) return null;
      const elems: Uint8Array[] = [];
      for (let k = 0; k < n; k++) elems.push(ctx.mem.inspect(base + k * size, size).bytes);
      const scratch = ctx.mem.malloc(size * 2);
      elems.sort((x, y) => {
        for (let k = 0; k < size; k++) ctx.mem.poke(scratch + k, x[k]!);
        for (let k = 0; k < size; k++) ctx.mem.poke(scratch + size + k, y[k]!);
        const r = ctx.callFunctionPointer(cmp, [ptrVal(VOIDP, scratch), ptrVal(VOIDP, scratch + size)]);
        return r ? Number(r.i) : 0;
      });
      ctx.mem.free(scratch);
      elems.forEach((e, k) => {
        for (let j = 0; j < size; j++) ctx.mem.poke(base + k * size + j, e[j]!);
      });
      return null;
    },

    // -- string --------------------------------------------------------------
    strlen(ctx, a) {
      return intVal(T.ULONG, BigInt(ctx.readCString(argInt(a, 0)).length));
    },
    strcmp(ctx, a) {
      return intVal(T.INT, BigInt(cmpBytes(cstr(ctx, argInt(a, 0)), cstr(ctx, argInt(a, 1)))));
    },
    strncmp(ctx, a) {
      const n = argInt(a, 2);
      return intVal(T.INT, BigInt(cmpBytes(cstr(ctx, argInt(a, 0)).slice(0, n), cstr(ctx, argInt(a, 1)).slice(0, n))));
    },
    strcpy(ctx, a) {
      const dst = argInt(a, 0);
      const src = cstr(ctx, argInt(a, 1));
      for (let k = 0; k < src.length; k++) ctx.mem.writeU8(dst + k, src[k]!);
      ctx.mem.writeU8(dst + src.length, 0);
      return ptrVal(CHARP, dst);
    },
    strncpy(ctx, a) {
      const dst = argInt(a, 0);
      const src = cstr(ctx, argInt(a, 1));
      const n = argInt(a, 2);
      for (let k = 0; k < n; k++) ctx.mem.writeU8(dst + k, k < src.length ? src[k]! : 0);
      return ptrVal(CHARP, dst);
    },
    strcat(ctx, a) {
      const dst = argInt(a, 0);
      const base = ctx.readCString(dst).length;
      const src = cstr(ctx, argInt(a, 1));
      for (let k = 0; k < src.length; k++) ctx.mem.writeU8(dst + base + k, src[k]!);
      ctx.mem.writeU8(dst + base + src.length, 0);
      return ptrVal(CHARP, dst);
    },
    strchr(ctx, a) {
      const s = argInt(a, 0);
      const ch = argInt(a, 1) & 0xff;
      const bytes = cstr(ctx, s);
      for (let k = 0; k < bytes.length; k++) if (bytes[k] === ch) return ptrVal(CHARP, s + k);
      return ch === 0 ? ptrVal(CHARP, s + bytes.length) : ptrVal(CHARP, 0);
    },
    strstr(ctx, a) {
      const hayAddr = argInt(a, 0);
      const hay = ctx.readCString(hayAddr);
      const needle = ctx.readCString(argInt(a, 1));
      const idx = hay.indexOf(needle);
      return ptrVal(CHARP, idx < 0 ? 0 : hayAddr + idx);
    },
    memcpy(ctx, a) {
      ctx.mem.copy(argInt(a, 0), argInt(a, 1), argInt(a, 2));
      return ptrVal(VOIDP, argInt(a, 0));
    },
    memmove(ctx, a) {
      const dst = argInt(a, 0), src = argInt(a, 1), n = argInt(a, 2);
      const tmp = ctx.mem.inspect(src, n).bytes;
      for (let k = 0; k < n; k++) ctx.mem.writeU8(dst + k, tmp[k]!);
      return ptrVal(VOIDP, dst);
    },
    memset(ctx, a) {
      ctx.mem.fill(argInt(a, 0), argInt(a, 1) & 0xff, argInt(a, 2));
      return ptrVal(VOIDP, argInt(a, 0));
    },
    memcmp(ctx, a) {
      const n = argInt(a, 2);
      const x = ctx.mem.inspect(argInt(a, 0), n).bytes;
      const y = ctx.mem.inspect(argInt(a, 1), n).bytes;
      for (let k = 0; k < n; k++) if (x[k] !== y[k]) return intVal(T.INT, BigInt(x[k]! - y[k]!));
      return intVal(T.INT, 0n);
    },

    // -- math ----------------------------------------------------------------
    sqrt: mathFn(Math.sqrt),
    pow: (_ctx, a) => floatVal(T.DOUBLE, Math.pow(argFloat(a, 0), argFloat(a, 1))),
    fabs: mathFn(Math.abs),
    floor: mathFn(Math.floor),
    ceil: mathFn(Math.ceil),
    round: mathFn(Math.round),
    sin: mathFn(Math.sin),
    cos: mathFn(Math.cos),
    tan: mathFn(Math.tan),
    exp: mathFn(Math.exp),
    log: mathFn(Math.log),
    log10: mathFn(Math.log10),
    fmod: (_ctx, a) => floatVal(T.DOUBLE, argFloat(a, 0) % argFloat(a, 1)),
  };

  return lib;
}

function mathFn(f: (x: number) => number): NativeFn {
  return (_ctx, a) => floatVal(T.DOUBLE, f(argFloat(a, 0)));
}

function cstr(ctx: Interp, addr: number): number[] {
  const s = ctx.readCString(addr);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
  return out;
}

function writeCString(ctx: Interp, addr: number, s: string): void {
  for (let i = 0; i < s.length; i++) ctx.mem.writeU8(addr + i, s.charCodeAt(i) & 0xff);
  ctx.mem.writeU8(addr + s.length, 0);
}

function cmpBytes(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseCInt(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s);
  return m ? parseInt(m[1]!, 10) : 0;
}
