import { describe, it, expect } from 'vitest';
import { Console } from './console';

describe('Console output', () => {
  it('accumulates stdout and stderr separately', () => {
    const c = new Console();
    c.write('out', 'hello ');
    c.write('out', 'world');
    c.write('err', 'oops');
    expect(c.stdout()).toBe('hello world');
    expect(c.stderr()).toBe('oops');
  });

  it('notifies output listeners in order', () => {
    const c = new Console();
    const seen: string[] = [];
    const off = c.onOutput((ch) => seen.push(`${ch.stream}:${ch.text}`));
    c.write('out', 'a');
    c.write('err', 'b');
    off();
    c.write('out', 'c');
    expect(seen).toEqual(['out:a', 'err:b']);
  });

  it('writeBytes decodes UTF-8', () => {
    const c = new Console();
    c.writeBytes('out', new Uint8Array([72, 105]));
    expect(c.stdout()).toBe('Hi');
  });
});

describe('Console input', () => {
  it('feeds and reads available bytes', () => {
    const c = new Console();
    c.feed('abc');
    expect(c.hasInput()).toBe(true);
    expect(c.readAvailable(2)).toEqual([97, 98]);
    expect(c.readAvailable(10)).toEqual([99]);
    expect(c.hasInput()).toBe(false);
  });

  it('readByte awaits then resolves, and returns -1 at EOF', async () => {
    const c = new Console();
    const p = c.readByte();
    c.feed('Z');
    expect(await p).toBe(90);
    c.closeInput();
    expect(await c.readByte()).toBe(-1);
    expect(c.atEof()).toBe(true);
  });
});
