import { describe, it, expect } from 'vitest';
import { Vfs, VfsError, normalize, dirname, basename } from './vfs';

describe('path helpers', () => {
  it('normalizes . .. and redundant slashes', () => {
    expect(normalize('/a/b/../c')).toBe('/a/c');
    expect(normalize('a/b', '/home')).toBe('/home/a/b');
    expect(normalize('/a//b/./c/')).toBe('/a/b/c');
    expect(normalize('/')).toBe('/');
    expect(normalize('..', '/a/b')).toBe('/a');
  });
  it('dirname/basename', () => {
    expect(dirname('/usr/include/stdio.h')).toBe('/usr/include');
    expect(basename('/usr/include/stdio.h')).toBe('stdio.h');
    expect(dirname('/x')).toBe('/');
  });
});

describe('Vfs files & dirs', () => {
  it('seeds conventional directories', () => {
    const v = new Vfs();
    expect(v.isDir('/usr/include')).toBe(true);
    expect(v.isDir('/home')).toBe(true);
    expect(v.isDir('/tmp')).toBe(true);
  });

  it('creates, reads, and writes text files', () => {
    const v = new Vfs();
    v.writeText('/home/main.c', 'int main(){return 0;}');
    expect(v.isFile('/home/main.c')).toBe(true);
    expect(v.readText('/home/main.c')).toBe('int main(){return 0;}');
  });

  it('mkdirp creates missing parents; mkdir does not', () => {
    const v = new Vfs();
    v.mkdirp('/a/b/c');
    expect(v.isDir('/a/b/c')).toBe(true);
    expect(() => v.mkdir('/x/y')).toThrow(VfsError);
  });

  it('readdir lists entries sorted', () => {
    const v = new Vfs();
    v.writeText('/home/b.c', '');
    v.writeText('/home/a.c', '');
    expect(v.readdir('/home')).toEqual(['a.c', 'b.c']);
  });

  it('unlink and rename', () => {
    const v = new Vfs();
    v.writeText('/tmp/x', 'hi');
    v.rename('/tmp/x', '/tmp/y');
    expect(v.exists('/tmp/x')).toBe(false);
    expect(v.readText('/tmp/y')).toBe('hi');
    v.unlink('/tmp/y');
    expect(v.exists('/tmp/y')).toBe(false);
  });

  it('rejects reading a missing file / a directory as a file', () => {
    const v = new Vfs();
    expect(() => v.readFile('/nope')).toThrow(VfsError);
    expect(() => v.readFile('/home')).toThrow(VfsError);
  });

  it('load and snapshot round-trip', () => {
    const v = new Vfs();
    v.load({ 'main.c': 'A', 'lib/util.c': 'B' });
    expect(v.readText('/home/main.c')).toBe('A');
    expect(v.readText('/home/lib/util.c')).toBe('B');
    const snap = v.snapshot();
    expect(snap['/home/main.c']).toBe('A');
    expect(snap['/home/lib/util.c']).toBe('B');
  });
});
