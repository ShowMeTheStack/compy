import { describe, it, expect } from 'vitest';
import { Syscalls, O, SEEK } from './syscall';
import { Vfs, VfsError } from './vfs';
import { Console } from './console';

function setup() {
  const vfs = new Vfs();
  const con = new Console();
  return { sys: new Syscalls(vfs, con), vfs, con };
}

const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const text = (b: Uint8Array) => String.fromCharCode(...b);

describe('Syscalls std streams', () => {
  it('write(1,…) and write(2,…) route to the console', () => {
    const { sys, con } = setup();
    sys.write(1, bytes('out'));
    sys.write(2, bytes('err'));
    expect(con.stdout()).toBe('out');
    expect(con.stderr()).toBe('err');
  });

  it('read(0,…) pulls from stdin', () => {
    const { sys, con } = setup();
    con.feed('hi');
    expect(text(sys.read(0, 10))).toBe('hi');
  });
});

describe('Syscalls file I/O', () => {
  it('O_CREAT|O_WRONLY creates and writes; reopen reads back', () => {
    const { sys } = setup();
    const fd = sys.open('/tmp/a.txt', O.WRONLY | O.CREAT);
    expect(fd).toBeGreaterThanOrEqual(3);
    expect(sys.write(fd, bytes('hello'))).toBe(5);
    sys.close(fd);
    const rfd = sys.open('/tmp/a.txt', O.RDONLY);
    expect(text(sys.read(rfd, 100))).toBe('hello');
  });

  it('O_APPEND writes at end', () => {
    const { sys, vfs } = setup();
    vfs.writeText('/tmp/log', 'a');
    const fd = sys.open('/tmp/log', O.WRONLY | O.APPEND);
    sys.write(fd, bytes('b'));
    expect(vfs.readText('/tmp/log')).toBe('ab');
  });

  it('O_TRUNC empties an existing file', () => {
    const { sys, vfs } = setup();
    vfs.writeText('/tmp/t', 'xxxx');
    const fd = sys.open('/tmp/t', O.WRONLY | O.TRUNC);
    sys.write(fd, bytes('y'));
    expect(vfs.readText('/tmp/t')).toBe('y');
  });

  it('O_CREAT|O_EXCL fails if the file exists', () => {
    const { sys, vfs } = setup();
    vfs.writeText('/tmp/e', '');
    expect(() => sys.open('/tmp/e', O.WRONLY | O.CREAT | O.EXCL)).toThrow(VfsError);
  });

  it('open of a missing file without O_CREAT fails (ENOENT)', () => {
    const { sys } = setup();
    expect(() => sys.open('/tmp/missing', O.RDONLY)).toThrow(VfsError);
  });

  it('lseek SET/CUR/END and partial reads', () => {
    const { sys, vfs } = setup();
    vfs.writeText('/tmp/s', 'ABCDEF');
    const fd = sys.open('/tmp/s', O.RDONLY);
    expect(text(sys.read(fd, 2))).toBe('AB');
    expect(sys.lseek(fd, 0, SEEK.SET)).toBe(0);
    expect(text(sys.read(fd, 1))).toBe('A');
    expect(sys.lseek(fd, 1, SEEK.CUR)).toBe(2);
    expect(text(sys.read(fd, 1))).toBe('C');
    expect(sys.lseek(fd, -1, SEEK.END)).toBe(5);
    expect(text(sys.read(fd, 5))).toBe('F');
  });

  it('reused fds come from the lowest free slot', () => {
    const { sys } = setup();
    const a = sys.open('/tmp/a', O.WRONLY | O.CREAT);
    const b = sys.open('/tmp/b', O.WRONLY | O.CREAT);
    expect([a, b]).toEqual([3, 4]);
    sys.close(a);
    const c = sys.open('/tmp/c', O.WRONLY | O.CREAT);
    expect(c).toBe(3);
  });

  it('operations on a bad fd throw EBADF', () => {
    const { sys } = setup();
    expect(() => sys.read(99, 1)).toThrow(VfsError);
    expect(() => sys.write(99, bytes('x'))).toThrow(VfsError);
    expect(() => sys.close(99)).toThrow(VfsError);
  });

  it('lseek on a console stream is ESPIPE', () => {
    const { sys } = setup();
    expect(() => sys.lseek(1, 0, SEEK.SET)).toThrow(VfsError);
  });
});
