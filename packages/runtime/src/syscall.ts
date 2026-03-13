import { Vfs, VfsError, E, normalize } from './vfs';
import { Console } from './console';

/**
 * The emulated syscall layer: a file-descriptor table over the VFS and the
 * console. fds 0/1/2 are stdin/stdout/stderr; opening a file returns the lowest
 * free fd ≥ 3. Operates on plain byte buffers — the libc/VM bridges these to and
 * from the simulated Memory. Errors surface as VfsError carrying an errno, which
 * libc maps to the C `errno` variable.
 */

// open() flags (Linux/musl values, matched by our <fcntl.h>).
export const O = {
  RDONLY: 0,
  WRONLY: 1,
  RDWR: 2,
  CREAT: 0o100, // 64
  EXCL: 0o200, // 128
  TRUNC: 0o1000, // 512
  APPEND: 0o2000, // 1024
} as const;

// lseek() whence.
export const SEEK = { SET: 0, CUR: 1, END: 2 } as const;

interface Fd {
  path: string;
  flags: number;
  pos: number;
  readable: boolean;
  writable: boolean;
  append: boolean;
  /** stdin/stdout/stderr route to the console instead of the VFS. */
  console: 'in' | 'out' | 'err' | null;
}

export class Syscalls {
  private fds = new Map<number, Fd>();
  private nextFd = 3;

  constructor(
    readonly vfs: Vfs,
    readonly console: Console,
  ) {
    this.fds.set(0, stdFd('in'));
    this.fds.set(1, stdFd('out'));
    this.fds.set(2, stdFd('err'));
  }

  private allocFd(): number {
    while (this.fds.has(this.nextFd)) this.nextFd++;
    return this.nextFd++;
  }

  open(path: string, flags: number, _mode = 0o644): number {
    const p = normalize(path);
    const exists = this.vfs.isFile(p);
    if (flags & O.CREAT && flags & O.EXCL && exists) {
      throw new VfsError(E.EXIST, 'EEXIST', p);
    }
    if (!exists) {
      if (flags & O.CREAT) this.vfs.createFile(p);
      else throw new VfsError(E.NOENT, 'ENOENT', p);
    } else if (flags & O.TRUNC && (flags & 0x3) !== O.RDONLY) {
      this.vfs.setData(p, new Uint8Array(0));
    }
    const acc = flags & 0x3;
    const append = (flags & O.APPEND) !== 0;
    const fd = this.allocFd();
    this.fds.set(fd, {
      path: p,
      flags,
      pos: append ? this.vfs.readFile(p).length : 0,
      readable: acc === O.RDONLY || acc === O.RDWR,
      writable: acc === O.WRONLY || acc === O.RDWR,
      append,
      console: null,
    });
    return fd;
  }

  close(fd: number): void {
    if (fd <= 2) return; // std streams stay open
    if (!this.fds.delete(fd)) throw new VfsError(E.BADF, 'EBADF', String(fd));
    if (fd < this.nextFd) this.nextFd = fd;
  }

  private get(fd: number): Fd {
    const f = this.fds.get(fd);
    if (!f) throw new VfsError(E.BADF, 'EBADF', String(fd));
    return f;
  }

  /** Read up to `count` bytes; returns the bytes read (empty at EOF). */
  read(fd: number, count: number): Uint8Array {
    const f = this.get(fd);
    if (f.console === 'in') return new Uint8Array(this.console.readAvailable(count));
    if (f.console) throw new VfsError(E.BADF, 'EBADF', 'not readable');
    if (!f.readable) throw new VfsError(E.BADF, 'EBADF', 'not readable');
    const data = this.vfs.readFile(f.path);
    const slice = data.slice(f.pos, f.pos + count);
    f.pos += slice.length;
    return slice;
  }

  /** Write bytes; returns the count written. */
  write(fd: number, bytes: Uint8Array): number {
    const f = this.get(fd);
    if (f.console === 'out' || f.console === 'err') {
      this.console.writeBytes(f.console === 'out' ? 'out' : 'err', bytes);
      return bytes.length;
    }
    if (f.console) throw new VfsError(E.BADF, 'EBADF', 'not writable');
    if (!f.writable) throw new VfsError(E.BADF, 'EBADF', 'not writable');
    const data = this.vfs.readFile(f.path);
    const at = f.append ? data.length : f.pos;
    const end = at + bytes.length;
    const next = new Uint8Array(Math.max(data.length, end));
    next.set(data);
    next.set(bytes, at);
    this.vfs.setData(f.path, next);
    f.pos = end;
    return bytes.length;
  }

  lseek(fd: number, offset: number, whence: number): number {
    const f = this.get(fd);
    if (f.console) throw new VfsError(E.SPIPE, 'ESPIPE', 'cannot seek a stream');
    const len = this.vfs.readFile(f.path).length;
    let pos: number;
    if (whence === SEEK.SET) pos = offset;
    else if (whence === SEEK.CUR) pos = f.pos + offset;
    else if (whence === SEEK.END) pos = len + offset;
    else throw new VfsError(E.INVAL, 'EINVAL', 'bad whence');
    if (pos < 0) throw new VfsError(E.INVAL, 'EINVAL', 'negative offset');
    f.pos = pos;
    return pos;
  }

  /** File size for fstat/ftell helpers. */
  size(fd: number): number {
    const f = this.get(fd);
    if (f.console) return 0;
    return this.vfs.readFile(f.path).length;
  }

  isOpen(fd: number): boolean {
    return this.fds.has(fd);
  }

  isConsole(fd: number): boolean {
    return this.fds.get(fd)?.console !== null && this.fds.has(fd);
  }
}

function stdFd(kind: 'in' | 'out' | 'err'): Fd {
  return {
    path: `/dev/std${kind}`,
    flags: kind === 'in' ? O.RDONLY : O.WRONLY,
    pos: 0,
    readable: kind === 'in',
    writable: kind !== 'in',
    append: false,
    console: kind,
  };
}
