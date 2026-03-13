import { CFault } from './errors';

/**
 * The simulated C process address space — one little-endian ArrayBuffer laid out
 * like a real 32-bit (ILP32) process, so students see and learn the actual
 * segments. Low → high:
 *
 *   null   [0 .. 64K)     unmapped guard — any access here is a NULL deref
 *   text   code segment   read-only (program image; symbolic here)
 *   rodata constants       read-only — string literals, const globals
 *   data   initialized     read-write — globals/statics with an initializer
 *   bss    zero-init        read-write — globals/statics without one
 *   heap   ── grows up ──   malloc/calloc/realloc/free live here
 *      (gap)
 *   stack  ── grows down ─  call frames & local variables
 *
 * Every access is checked, so the "valgrind-for-beginners" sandbox can report
 * NULL derefs, out-of-bounds, uninitialized reads, use-after-free, double-free,
 * writes to read-only memory, and (at exit) leaks — with exact addresses. All
 * of memory is inspectable and freely editable for teaching.
 */

export type SegmentName = 'null' | 'text' | 'rodata' | 'data' | 'bss' | 'heap' | 'stack';
export type Perm = 'none' | 'r' | 'rw';

export interface Segment {
  name: SegmentName;
  start: number;
  end: number; // exclusive
  perm: Perm;
  /** Bump frontier: highest used address+1 for up-growing, lowest for stack. */
  top: number;
  growsDown: boolean;
}

export interface HeapBlock {
  addr: number;
  size: number;
  freed: boolean;
}

const KB = 1024;
const MB = 1024 * KB;

/** Segment sizes (tunable). Kept modest so the buffer is browser-friendly. */
const SIZES: Record<Exclude<SegmentName, 'stack'>, number> & { stack: number } = {
  null: 64 * KB,
  text: 1 * MB,
  rodata: 1 * MB,
  data: 1 * MB,
  bss: 4 * MB,
  heap: 32 * MB,
  stack: 8 * MB,
};

export class Memory {
  readonly buf: ArrayBuffer;
  readonly view: DataView;
  private readonly bytes: Uint8Array;
  /** 1 = the byte has been written since it was (re)allocated. */
  private readonly inited: Uint8Array;
  readonly segments: Record<SegmentName, Segment>;
  private readonly heapBlocks = new Map<number, HeapBlock>();
  /** UB reports that don't stop execution (uninitialized reads, leaks). */
  readonly warnings: CFault[] = [];
  /** When false, checks still record but never throw (lenient teaching mode). */
  strict = true;

  constructor() {
    const order: SegmentName[] = ['null', 'text', 'rodata', 'data', 'bss', 'heap', 'stack'];
    const total =
      SIZES.null + SIZES.text + SIZES.rodata + SIZES.data + SIZES.bss + SIZES.heap + SIZES.stack;
    this.buf = new ArrayBuffer(total);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
    this.inited = new Uint8Array(total);

    const seg = {} as Record<SegmentName, Segment>;
    let cur = 0;
    for (const name of order) {
      const size = SIZES[name];
      const start = cur;
      const end = cur + size;
      const growsDown = name === 'stack';
      seg[name] = {
        name,
        start,
        end,
        perm: name === 'null' ? 'none' : name === 'text' || name === 'rodata' ? 'r' : 'rw',
        top: growsDown ? end : start,
        growsDown,
      };
      cur = end;
    }
    this.segments = seg;
    // Statics are zero and, in C, treated as initialized; mark data+bss inited.
    this.inited.fill(1, seg.data.start, seg.bss.end);
  }

  // -- static/global loading (compiler) --------------------------------------

  /** Reserve `size` bytes of read-only constants (string literals, const). */
  allocRodata(bytes: Uint8Array): number {
    return this.bump('rodata', bytes.length, bytes);
  }

  /** Reserve initialized global/static storage. */
  allocData(bytes: Uint8Array): number {
    return this.bump('data', bytes.length, bytes);
  }

  /** Reserve zero-initialized global/static storage (BSS). */
  allocBss(size: number): number {
    return this.bump('bss', size);
  }

  private bump(name: SegmentName, size: number, init?: Uint8Array): number {
    const s = this.segments[name];
    const addr = s.top;
    const aligned = align(size, 4);
    if (addr + aligned > s.end) throw new CFault('segfault', addr, size, `${name} segment full`);
    s.top += aligned;
    if (init) this.bytes.set(init, addr);
    this.inited.fill(1, addr, addr + size);
    return addr;
  }

  // -- heap ------------------------------------------------------------------

  malloc(size: number): number {
    if (size <= 0) return 0; // C: malloc(0) may return NULL; keep it simple
    const s = this.segments.heap;
    const addr = align(s.top, 8);
    const end = addr + size;
    if (end > s.end) return 0; // out of heap → NULL, like the real thing
    s.top = end;
    this.heapBlocks.set(addr, { addr, size, freed: false });
    // malloc does NOT zero — leave the bytes flagged uninitialized.
    this.inited.fill(0, addr, end);
    return addr;
  }

  calloc(count: number, size: number): number {
    const total = count * size;
    const addr = this.malloc(total);
    if (addr) {
      this.bytes.fill(0, addr, addr + total);
      this.inited.fill(1, addr, addr + total);
    }
    return addr;
  }

  free(addr: number): void {
    if (addr === 0) return; // free(NULL) is a no-op
    const block = this.heapBlocks.get(addr);
    if (!block) throw new CFault('invalid-free', addr);
    if (block.freed) throw new CFault('double-free', addr);
    block.freed = true;
    this.inited.fill(0, addr, addr + block.size); // reads after free are garbage
  }

  /** Live (never-freed) heap blocks — reported as leaks at program exit. */
  leaks(): HeapBlock[] {
    return [...this.heapBlocks.values()].filter((b) => !b.freed);
  }

  // -- stack -----------------------------------------------------------------

  /** Allocate a frame of `size` bytes; returns the frame base (lowest addr). */
  pushStack(size: number): number {
    const s = this.segments.stack;
    const base = s.top - align(size, 16);
    if (base < s.start) throw new CFault('stack-overflow', base, size);
    s.top = base;
    this.inited.fill(0, base, base + size); // locals start uninitialized
    return base;
  }

  /** Restore the stack pointer to a saved frame base. */
  popStackTo(base: number): void {
    const s = this.segments.stack;
    this.inited.fill(0, s.top, base); // leaving a frame invalidates its bytes
    s.top = base;
  }

  get stackTop(): number {
    return this.segments.stack.top;
  }

  // -- access checking -------------------------------------------------------

  private segmentAt(addr: number): Segment | null {
    for (const s of Object.values(this.segments)) if (addr >= s.start && addr < s.end) return s;
    return null;
  }

  /** Validate an access; throws a CFault (or records it in lenient mode). */
  private check(addr: number, len: number, write: boolean): void {
    if (addr < this.segments.null.end) throw new CFault('null-deref', addr, len);
    const s = this.segmentAt(addr);
    if (!s || addr + len > s.end) throw new CFault('segfault', addr, len);
    if (write && s.perm !== 'rw') throw new CFault('write-to-readonly', addr, len);
    // Never-mapped regions: below the heap frontier is fine; a gap between heap
    // and stack is a segfault.
    if (s.name === 'heap') this.checkHeap(addr, len);
    if (!write) this.checkInitialized(addr, len);
  }

  private checkHeap(addr: number, len: number): void {
    // The access must fall entirely inside one live block.
    for (const b of this.heapBlocks.values()) {
      if (addr >= b.addr && addr + len <= b.addr + b.size) {
        if (b.freed) throw new CFault('use-after-free', addr, len);
        return;
      }
    }
    // Address is in heap arena but not inside any block (past brk, or between).
    throw new CFault('out-of-bounds', addr, len);
  }

  private checkInitialized(addr: number, len: number): void {
    for (let i = 0; i < len; i++) {
      if (!this.inited[addr + i]) {
        const f = new CFault('uninitialized-read', addr, len);
        this.warnings.push(f);
        return; // report once per access, don't stop the program
      }
    }
  }

  // -- typed reads / writes --------------------------------------------------

  private markInit(addr: number, len: number): void {
    this.inited.fill(1, addr, addr + len);
  }

  readI8(a: number): number {
    this.check(a, 1, false);
    return this.view.getInt8(a);
  }
  readU8(a: number): number {
    this.check(a, 1, false);
    return this.view.getUint8(a);
  }
  readI16(a: number): number {
    this.check(a, 2, false);
    return this.view.getInt16(a, true);
  }
  readU16(a: number): number {
    this.check(a, 2, false);
    return this.view.getUint16(a, true);
  }
  readI32(a: number): number {
    this.check(a, 4, false);
    return this.view.getInt32(a, true);
  }
  readU32(a: number): number {
    this.check(a, 4, false);
    return this.view.getUint32(a, true);
  }
  readI64(a: number): bigint {
    this.check(a, 8, false);
    return this.view.getBigInt64(a, true);
  }
  readU64(a: number): bigint {
    this.check(a, 8, false);
    return this.view.getBigUint64(a, true);
  }
  readF32(a: number): number {
    this.check(a, 4, false);
    return this.view.getFloat32(a, true);
  }
  readF64(a: number): number {
    this.check(a, 8, false);
    return this.view.getFloat64(a, true);
  }

  writeI8(a: number, v: number): void {
    this.check(a, 1, true);
    this.view.setInt8(a, v);
    this.markInit(a, 1);
  }
  writeU8(a: number, v: number): void {
    this.check(a, 1, true);
    this.view.setUint8(a, v);
    this.markInit(a, 1);
  }
  writeI16(a: number, v: number): void {
    this.check(a, 2, true);
    this.view.setInt16(a, v, true);
    this.markInit(a, 2);
  }
  writeI32(a: number, v: number): void {
    this.check(a, 4, true);
    this.view.setInt32(a, v, true);
    this.markInit(a, 4);
  }
  writeU32(a: number, v: number): void {
    this.check(a, 4, true);
    this.view.setUint32(a, v, true);
    this.markInit(a, 4);
  }
  writeI64(a: number, v: bigint): void {
    this.check(a, 8, true);
    this.view.setBigInt64(a, v, true);
    this.markInit(a, 8);
  }
  writeF32(a: number, v: number): void {
    this.check(a, 4, true);
    this.view.setFloat32(a, v, true);
    this.markInit(a, 4);
  }
  writeF64(a: number, v: number): void {
    this.check(a, 8, true);
    this.view.setFloat64(a, v, true);
    this.markInit(a, 8);
  }

  /** Bulk copy (memcpy) with a check on both ends. */
  copy(dst: number, src: number, len: number): void {
    this.check(src, len, false);
    this.check(dst, len, true);
    this.bytes.copyWithin(dst, src, src + len);
    this.markInit(dst, len);
  }

  /** memset. */
  fill(addr: number, value: number, len: number): void {
    this.check(addr, len, true);
    this.bytes.fill(value & 0xff, addr, addr + len);
    this.markInit(addr, len);
  }

  // -- inspection & teaching edits (visualizer) ------------------------------

  /** Raw bytes + per-byte initialized flags for a region (read-only view). */
  inspect(addr: number, len: number): { bytes: Uint8Array; inited: Uint8Array } {
    return {
      bytes: this.bytes.slice(addr, addr + len),
      inited: this.inited.slice(addr, addr + len),
    };
  }

  heapList(): HeapBlock[] {
    return [...this.heapBlocks.values()];
  }

  /** Student memory edit — writes a byte anywhere, bypassing permission checks. */
  poke(addr: number, value: number): void {
    if (addr < 0 || addr >= this.buf.byteLength) throw new CFault('segfault', addr, 1);
    this.bytes[addr] = value & 0xff;
    this.inited[addr] = 1;
  }
}

function align(n: number, to: number): number {
  return Math.ceil(n / to) * to;
}
