import { describe, it, expect } from 'vitest';
import { Memory } from './memory';
import { CFault, type FaultKind } from './errors';

function faultKind(fn: () => void): FaultKind | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof CFault) return e.kind;
    throw e;
  }
}

describe('Memory layout', () => {
  it('lays out segments low→high in the canonical order', () => {
    const m = new Memory();
    const order = ['null', 'text', 'rodata', 'data', 'bss', 'heap', 'stack'] as const;
    let prevEnd = 0;
    for (const name of order) {
      const s = m.segments[name];
      expect(s.start).toBe(prevEnd);
      expect(s.end).toBeGreaterThan(s.start);
      prevEnd = s.end;
    }
  });

  it('gives rodata/text read-only perms and data/bss/heap/stack rw', () => {
    const m = new Memory();
    expect(m.segments.text.perm).toBe('r');
    expect(m.segments.rodata.perm).toBe('r');
    expect(m.segments.data.perm).toBe('rw');
    expect(m.segments.bss.perm).toBe('rw');
    expect(m.segments.heap.perm).toBe('rw');
    expect(m.segments.stack.perm).toBe('rw');
    expect(m.segments.null.perm).toBe('none');
  });
});

describe('valgrind-for-beginners faults', () => {
  it('null-deref: reading through address 0', () => {
    const m = new Memory();
    expect(faultKind(() => m.readI32(0))).toBe('null-deref');
    expect(faultKind(() => m.readI32(4))).toBe('null-deref');
  });

  it('write-to-readonly: writing a string literal in rodata', () => {
    const m = new Memory();
    const a = m.allocRodata(new Uint8Array([72, 105, 0])); // "Hi"
    expect(m.readU8(a)).toBe(72);
    expect(faultKind(() => m.writeU8(a, 0))).toBe('write-to-readonly');
  });

  it('use-after-free and double-free on the heap', () => {
    const m = new Memory();
    const p = m.malloc(16);
    expect(p).toBeGreaterThan(0);
    m.writeI32(p, 123);
    expect(m.readI32(p)).toBe(123);
    m.free(p);
    expect(faultKind(() => m.readI32(p))).toBe('use-after-free');
    expect(faultKind(() => m.free(p))).toBe('double-free');
  });

  it('invalid-free: freeing a non-heap / interior pointer', () => {
    const m = new Memory();
    expect(faultKind(() => m.free(m.segments.heap.start + 4))).toBe('invalid-free');
    const p = m.malloc(16);
    expect(faultKind(() => m.free(p + 4))).toBe('invalid-free');
  });

  it('out-of-bounds: reading past a heap block', () => {
    const m = new Memory();
    const p = m.malloc(8);
    m.writeI32(p, 1);
    m.writeI32(p + 4, 2);
    expect(faultKind(() => m.readI32(p + 8))).toBe('out-of-bounds');
  });

  it('uninitialized-read: malloc does not zero', () => {
    const m = new Memory();
    const p = m.malloc(8);
    m.readI32(p); // records a warning, does not throw
    expect(m.warnings.some((w) => w.kind === 'uninitialized-read')).toBe(true);
  });

  it('calloc zeroes and initializes', () => {
    const m = new Memory();
    const p = m.calloc(4, 4);
    expect(m.readI32(p)).toBe(0);
    expect(m.warnings.length).toBe(0);
  });

  it('leak: unfreed blocks are reported', () => {
    const m = new Memory();
    m.malloc(32);
    const p = m.malloc(16);
    m.free(p);
    const leaks = m.leaks();
    expect(leaks.length).toBe(1);
    expect(leaks[0]!.size).toBe(32);
  });

  it('stack-overflow: exhausting the stack segment', () => {
    const m = new Memory();
    let kind: FaultKind | null = null;
    try {
      for (let i = 0; i < 100000; i++) m.pushStack(1024);
    } catch (e) {
      if (e instanceof CFault) kind = e.kind;
    }
    expect(kind).toBe('stack-overflow');
  });
});

describe('typed access and initialization tracking', () => {
  it('round-trips every width in data-like storage', () => {
    const m = new Memory();
    const a = m.allocData(new Uint8Array(64));
    m.writeI8(a, -5);
    expect(m.readI8(a)).toBe(-5);
    m.writeI16(a + 2, -1000);
    expect(m.readI16(a + 2)).toBe(-1000);
    m.writeI32(a + 4, 123456);
    expect(m.readI32(a + 4)).toBe(123456);
    m.writeI64(a + 8, 9999999999n);
    expect(m.readI64(a + 8)).toBe(9999999999n);
    m.writeF32(a + 16, 1.5);
    expect(m.readF32(a + 16)).toBeCloseTo(1.5);
    m.writeF64(a + 24, 3.14159);
    expect(m.readF64(a + 24)).toBeCloseTo(3.14159);
  });

  it('stack locals start uninitialized, become initialized on write', () => {
    const m = new Memory();
    const base = m.pushStack(16);
    m.readI32(base);
    expect(m.warnings.some((w) => w.kind === 'uninitialized-read')).toBe(true);
    m.warnings.length = 0;
    m.writeI32(base, 7);
    m.readI32(base);
    expect(m.warnings.length).toBe(0);
  });

  it('popStackTo invalidates a frame', () => {
    const m = new Memory();
    const outer = m.stackTop;
    const base = m.pushStack(16);
    m.writeI32(base, 42);
    m.popStackTo(outer);
    expect(m.stackTop).toBe(outer);
  });
});

describe('inspection & teaching edits', () => {
  it('inspect returns bytes and init flags', () => {
    const m = new Memory();
    const a = m.allocData(new Uint8Array([1, 2, 3, 4]));
    const { bytes, inited } = m.inspect(a, 4);
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    expect([...inited]).toEqual([1, 1, 1, 1]);
  });

  it('poke edits read-only memory (student override)', () => {
    const m = new Memory();
    const a = m.allocRodata(new Uint8Array([9]));
    expect(faultKind(() => m.writeU8(a, 5))).toBe('write-to-readonly');
    m.poke(a, 5); // bypasses perms
    expect(m.readU8(a)).toBe(5);
  });
});
