import * as T from '@compy/cc';
import { Interp, Val, NativeFn, intVal, floatVal, ptrVal } from '@compy/vm';
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
  const fileCache = new Map<number, number>(); // fd -> FILE* struct address
  let errnoAddr = 0;
  let logicalClock = 0;

  /** FILE* struct: [0]=fd (int), [4]=eof/err flags (int). */
  const fileFd = (ctx: Interp, fileAddr: number): number => (fileAddr < 16 ? fileAddr : ctx.mem.readI32(fileAddr));
  const iob = (ctx: Interp, fd: number): number => {
    let a = fileCache.get(fd);
    if (a === undefined) {
      a = ctx.mem.malloc(16);
      ctx.mem.writeI32(a, fd);
      ctx.mem.writeI32(a + 4, 0);
      fileCache.set(fd, a);
    }
    return a;
  };
  const errnoCell = (ctx: Interp): number => {
    if (!errnoAddr) {
      errnoAddr = ctx.mem.malloc(4);
      ctx.mem.writeI32(errnoAddr, 0);
    }
    return errnoAddr;
  };

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
      const fd = fileFd(ctx, argInt(a, 0));
      const fmt = ctx.readCString(argInt(a, 1));
      const out = formatPrintf(ctx, fmt, a, 2);
      ctx.sys.write(fd, new TextEncoder().encode(out));
      return intVal(T.INT, BigInt(out.length));
    },
    __iob(ctx, a) {
      return ptrVal(VOIDP, iob(ctx, argInt(a, 0)));
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

    // -- stdio: character & line I/O ----------------------------------------
    getchar(ctx) {
      const b = ctx.sys.read(0, 1);
      return intVal(T.INT, b.length ? BigInt(b[0]!) : -1n);
    },
    fgetc(ctx, a) {
      const b = ctx.sys.read(fileFd(ctx, argInt(a, 0)), 1);
      return intVal(T.INT, b.length ? BigInt(b[0]!) : -1n);
    },
    getc(ctx, a) {
      const b = ctx.sys.read(fileFd(ctx, argInt(a, 0)), 1);
      return intVal(T.INT, b.length ? BigInt(b[0]!) : -1n);
    },
    fputc(ctx, a) {
      const c = argInt(a, 0) & 0xff;
      ctx.sys.write(fileFd(ctx, argInt(a, 1)), new Uint8Array([c]));
      return intVal(T.INT, BigInt(c));
    },
    putc(ctx, a) {
      const c = argInt(a, 0) & 0xff;
      ctx.sys.write(fileFd(ctx, argInt(a, 1)), new Uint8Array([c]));
      return intVal(T.INT, BigInt(c));
    },
    fputs(ctx, a) {
      const s = ctx.readCString(argInt(a, 0));
      ctx.sys.write(fileFd(ctx, argInt(a, 1)), new TextEncoder().encode(s));
      return intVal(T.INT, BigInt(s.length));
    },
    fgets(ctx, a) {
      const dst = argInt(a, 0);
      const n = argInt(a, 1);
      const fd = fileFd(ctx, argInt(a, 2));
      let i = 0;
      while (i < n - 1) {
        const b = ctx.sys.read(fd, 1);
        if (!b.length) break;
        ctx.mem.writeU8(dst + i, b[0]!);
        i++;
        if (b[0] === 10) break;
      }
      if (i === 0) return ptrVal(CHARP, 0);
      ctx.mem.writeU8(dst + i, 0);
      return ptrVal(CHARP, dst);
    },

    // -- stdio: file streams over the VFS -----------------------------------
    fopen(ctx, a) {
      const path = ctx.readCString(argInt(a, 0));
      const mode = ctx.readCString(argInt(a, 1));
      const O = { RDONLY: 0, WRONLY: 1, RDWR: 2, CREAT: 0o100, TRUNC: 0o1000, APPEND: 0o2000 };
      let flags = 0;
      if (mode.startsWith('r')) flags = mode.includes('+') ? O.RDWR : O.RDONLY;
      else if (mode.startsWith('w')) flags = (mode.includes('+') ? O.RDWR : O.WRONLY) | O.CREAT | O.TRUNC;
      else if (mode.startsWith('a')) flags = (mode.includes('+') ? O.RDWR : O.WRONLY) | O.CREAT | O.APPEND;
      try {
        const fd = ctx.sys.open(path.startsWith('/') ? path : '/home/' + path, flags);
        const f = ctx.mem.malloc(16);
        ctx.mem.writeI32(f, fd);
        ctx.mem.writeI32(f + 4, 0);
        return ptrVal(VOIDP, f);
      } catch {
        ctx.mem.writeI32(errnoCell(ctx), 2);
        return ptrVal(VOIDP, 0);
      }
    },
    fclose(ctx, a) {
      const fileAddr = argInt(a, 0);
      const fd = fileFd(ctx, fileAddr);
      try {
        ctx.sys.close(fd);
      } catch {
        /* already closed */
      }
      if (fileAddr >= 16) ctx.mem.free(fileAddr);
      return intVal(T.INT, 0n);
    },
    fread(ctx, a) {
      const dst = argInt(a, 0);
      const size = argInt(a, 1);
      const nmemb = argInt(a, 2);
      const fd = fileFd(ctx, argInt(a, 3));
      const bytes = ctx.sys.read(fd, size * nmemb);
      for (let k = 0; k < bytes.length; k++) ctx.mem.writeU8(dst + k, bytes[k]!);
      return intVal(T.ULONG, BigInt(size ? Math.floor(bytes.length / size) : 0));
    },
    fwrite(ctx, a) {
      const src = argInt(a, 0);
      const size = argInt(a, 1);
      const nmemb = argInt(a, 2);
      const fd = fileFd(ctx, argInt(a, 3));
      const total = size * nmemb;
      const buf = ctx.mem.inspect(src, total).bytes;
      ctx.sys.write(fd, buf);
      return intVal(T.ULONG, BigInt(nmemb));
    },
    fseek(ctx, a) {
      try {
        ctx.sys.lseek(fileFd(ctx, argInt(a, 0)), argInt(a, 1), argInt(a, 2));
        return intVal(T.INT, 0n);
      } catch {
        return intVal(T.INT, -1n);
      }
    },
    ftell(ctx, a) {
      try {
        return intVal(T.LONG, BigInt(ctx.sys.lseek(fileFd(ctx, argInt(a, 0)), 0, 1)));
      } catch {
        return intVal(T.LONG, -1n);
      }
    },
    rewind(ctx, a) {
      try {
        ctx.sys.lseek(fileFd(ctx, argInt(a, 0)), 0, 0);
      } catch {
        /* stream */
      }
      return null;
    },
    feof(ctx, a) {
      const fd = fileFd(ctx, argInt(a, 0));
      // Best-effort: at EOF when a peek read returns nothing and no more bytes.
      return intVal(T.INT, ctx.sys.isConsole(fd) && ctx.con.atEof() ? 1n : 0n);
    },
    ferror() {
      return intVal(T.INT, 0n);
    },
    clearerr() {
      return null;
    },
    fflush() {
      return intVal(T.INT, 0n);
    },
    remove(ctx, a) {
      const p = ctx.readCString(argInt(a, 0));
      try {
        ctx.vfs.unlink(p.startsWith('/') ? p : '/home/' + p);
        return intVal(T.INT, 0n);
      } catch {
        return intVal(T.INT, -1n);
      }
    },
    perror(ctx, a) {
      const s = ctx.readCString(argInt(a, 0));
      ctx.sys.write(2, new TextEncoder().encode((s ? s + ': ' : '') + 'error\n'));
      return null;
    },

    // -- scanf family --------------------------------------------------------
    scanf(ctx, a) {
      const input = drainConsole(ctx);
      return intVal(T.INT, BigInt(runScanf(ctx, input.text, ctx.readCString(argInt(a, 0)), a, 1, input.putBack)));
    },
    sscanf(ctx, a) {
      const src = ctx.readCString(argInt(a, 0));
      return intVal(T.INT, BigInt(runScanf(ctx, src, ctx.readCString(argInt(a, 1)), a, 2, () => {})));
    },
    fscanf(ctx, a) {
      const fd = fileFd(ctx, argInt(a, 0));
      const bytes: number[] = [];
      for (;;) {
        const b = ctx.sys.read(fd, 1);
        if (!b.length) break;
        bytes.push(b[0]!);
      }
      const text = String.fromCharCode(...bytes);
      return intVal(T.INT, BigInt(runScanf(ctx, text, ctx.readCString(argInt(a, 1)), a, 2, () => {})));
    },

    // -- ctype ---------------------------------------------------------------
    isalpha: ctypeFn((c) => /[A-Za-z]/.test(c)),
    isdigit: ctypeFn((c) => c >= '0' && c <= '9'),
    isalnum: ctypeFn((c) => /[A-Za-z0-9]/.test(c)),
    isspace: ctypeFn((c) => /\s/.test(c)),
    isupper: ctypeFn((c) => c >= 'A' && c <= 'Z'),
    islower: ctypeFn((c) => c >= 'a' && c <= 'z'),
    ispunct: ctypeFn((c) => /[!-/:-@[-`{-~]/.test(c)),
    isprint: ctypeFn((c) => c >= ' ' && c.charCodeAt(0) < 127),
    isgraph: ctypeFn((c) => c > ' ' && c.charCodeAt(0) < 127),
    iscntrl: ctypeFn((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    isxdigit: ctypeFn((c) => /[0-9a-fA-F]/.test(c)),
    toupper(_ctx, a) {
      const c = argInt(a, 0);
      return intVal(T.INT, BigInt(c >= 97 && c <= 122 ? c - 32 : c));
    },
    tolower(_ctx, a) {
      const c = argInt(a, 0);
      return intVal(T.INT, BigInt(c >= 65 && c <= 90 ? c + 32 : c));
    },

    // -- errno / assert ------------------------------------------------------
    __errno_location(ctx) {
      return ptrVal(T.pointerTo(T.INT), errnoCell(ctx));
    },
    strerror(_ctx, _a) {
      return ptrVal(CHARP, 0);
    },
    __assert_fail(ctx, a) {
      const expr = ctx.readCString(argInt(a, 0));
      const file = ctx.readCString(argInt(a, 1));
      const line = argInt(a, 2);
      ctx.con.write('err', `Assertion failed: ${expr}, file ${file}, line ${line}\n`);
      return ctx.exit(134);
    },

    // -- time ----------------------------------------------------------------
    time(ctx, a) {
      const t = ++logicalClock;
      const ptr = argInt(a, 0);
      if (ptr) ctx.mem.writeI32(ptr, t);
      return intVal(T.LONG, BigInt(t));
    },
    clock() {
      return intVal(T.LONG, BigInt(++logicalClock));
    },
  };

  return lib;
}

function ctypeFn(pred: (c: string) => boolean): NativeFn {
  return (_ctx, a) => {
    const code = argInt(a, 0);
    const ch = code >= 0 && code < 256 ? String.fromCharCode(code) : '\0';
    return intVal(T.INT, pred(ch) ? 1n : 0n);
  };
}

/** Drain all buffered console input into a string for scanf. */
function drainConsole(ctx: Interp): { text: string; putBack: (rest: string) => void } {
  const bytes: number[] = [];
  for (;;) {
    const b = ctx.sys.read(0, 1);
    if (!b.length) break;
    bytes.push(b[0]!);
  }
  return {
    text: String.fromCharCode(...bytes),
    putBack: (rest: string) => {
      if (rest) ctx.con.feed(rest);
    },
  };
}

/** A minimal scanf: whitespace-skipping, %d %u %x %o %c %s %f/%e/%g, width. */
function runScanf(ctx: Interp, input: string, fmt: string, args: Val[], startIdx: number, putBack: (rest: string) => void): number {
  let ip = 0;
  let ai = startIdx;
  let assigned = 0;
  const nextArgAddr = (): number => Number(args[ai++]?.i ?? 0n);
  const skipWs = () => {
    while (ip < input.length && /\s/.test(input[ip]!)) ip++;
  };

  let fi = 0;
  while (fi < fmt.length) {
    const c = fmt[fi]!;
    if (/\s/.test(c)) {
      skipWs();
      fi++;
      continue;
    }
    if (c !== '%') {
      skipWs();
      if (input[ip] === c) {
        ip++;
        fi++;
        continue;
      }
      break;
    }
    fi++; // past '%'
    let suppress = false;
    if (fmt[fi] === '*') {
      suppress = true;
      fi++;
    }
    let width = 0;
    while (fmt[fi] && fmt[fi]! >= '0' && fmt[fi]! <= '9') width = width * 10 + (fmt[fi++]!.charCodeAt(0) - 48);
    let isLong = false;
    while (fmt[fi] && 'hlL'.includes(fmt[fi]!)) {
      if (fmt[fi] === 'l' || fmt[fi] === 'L') isLong = true;
      fi++;
    }
    const spec = fmt[fi++];

    if (spec === '%') {
      skipWs();
      if (input[ip] === '%') ip++;
      continue;
    }
    if (spec === 'c') {
      if (ip >= input.length) break;
      const ch = input[ip++]!;
      if (!suppress) {
        ctx.mem.writeU8(nextArgAddr(), ch.charCodeAt(0) & 0xff);
        assigned++;
      }
      continue;
    }
    skipWs();
    const start = ip;
    if (spec === 's') {
      while (ip < input.length && !/\s/.test(input[ip]!) && (width === 0 || ip - start < width)) ip++;
      if (ip === start) break;
      const s = input.slice(start, ip);
      if (!suppress) {
        const addr = nextArgAddr();
        for (let k = 0; k < s.length; k++) ctx.mem.writeU8(addr + k, s.charCodeAt(k) & 0xff);
        ctx.mem.writeU8(addr + s.length, 0);
        assigned++;
      }
      continue;
    }
    if (spec === 'd' || spec === 'i' || spec === 'u' || spec === 'x' || spec === 'o') {
      const re = spec === 'x' ? /[+-]?(0[xX])?[0-9a-fA-F]+/y : /[+-]?\d+/y;
      re.lastIndex = ip;
      const m = re.exec(input);
      if (!m || m.index !== ip) break;
      ip = re.lastIndex;
      const base = spec === 'x' ? 16 : spec === 'o' ? 8 : 10;
      const val = parseInt(m[0], base);
      if (!suppress) {
        ctx.mem.writeI32(nextArgAddr(), val | 0);
        assigned++;
      }
      continue;
    }
    if (spec === 'f' || spec === 'e' || spec === 'g') {
      const re = /[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/y;
      re.lastIndex = ip;
      const m = re.exec(input);
      if (!m || m.index !== ip) break;
      ip = re.lastIndex;
      if (!suppress) {
        const addr = nextArgAddr();
        if (isLong) ctx.mem.writeF64(addr, parseFloat(m[0]));
        else ctx.mem.writeF32(addr, Math.fround(parseFloat(m[0])));
        assigned++;
      }
      continue;
    }
    break;
  }
  putBack(input.slice(ip));
  return assigned;
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
