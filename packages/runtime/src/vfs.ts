/**
 * Unix-style virtual filesystem for the C sandbox. Files and directories live
 * in a single tree keyed by normalized absolute paths ("/", "/usr/include",
 * "/home/main.c"). Content is raw bytes. This layer is DOM-free and knows
 * nothing about file descriptors — the syscall layer adds fds, cursors, and the
 * console streams on top. The IDE syncs the project (and libc headers) in and
 * out via load()/snapshot().
 */

export class VfsError extends Error {
  constructor(
    readonly errno: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'VfsError';
  }
}

// errno values the libc <errno.h> exposes; enough for teaching.
export const E = {
  PERM: 1, // EPERM
  NOENT: 2, // ENOENT — no such file or directory
  BADF: 9, // EBADF — bad file descriptor
  ACCES: 13, // EACCES
  EXIST: 17, // EEXIST
  NOTDIR: 20, // ENOTDIR
  ISDIR: 21, // EISDIR
  INVAL: 22, // EINVAL
  MFILE: 24, // EMFILE — too many open files
  SPIPE: 29, // ESPIPE — illegal seek
} as const;

export interface VNode {
  type: 'file' | 'dir';
  /** File content (files only). */
  data: Uint8Array;
  /** Child name → node (dirs only). */
  children: Map<string, VNode>;
  mode: number; // permission bits (informational)
  mtime: number; // logical timestamp, bumped on write
}

/** Normalize a path to a canonical absolute form: "/a/b", no trailing slash. */
export function normalize(path: string, cwd = '/'): string {
  let p = path;
  if (!p.startsWith('/')) p = (cwd.endsWith('/') ? cwd : cwd + '/') + p;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

export function dirname(path: string): string {
  const n = normalize(path);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

export function basename(path: string): string {
  const n = normalize(path);
  return n.slice(n.lastIndexOf('/') + 1);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Vfs {
  private root: VNode = newDir();
  private clock = 1;

  constructor() {
    // A few conventional directories so #include paths and cwd resolve cleanly.
    for (const d of ['/usr', '/usr/include', '/home', '/tmp']) this.mkdirp(d);
  }

  private newTime(): number {
    return this.clock++;
  }

  // -- lookup ---------------------------------------------------------------

  private lookup(path: string): VNode | null {
    const n = normalize(path);
    if (n === '/') return this.root;
    let cur = this.root;
    for (const seg of n.slice(1).split('/')) {
      if (cur.type !== 'dir') return null;
      const next = cur.children.get(seg);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  exists(path: string): boolean {
    return this.lookup(path) !== null;
  }

  isDir(path: string): boolean {
    return this.lookup(path)?.type === 'dir';
  }

  isFile(path: string): boolean {
    return this.lookup(path)?.type === 'file';
  }

  // -- directories ----------------------------------------------------------

  /** Create a directory (parent must exist). */
  mkdir(path: string): void {
    const n = normalize(path);
    if (n === '/') throw new VfsError(E.EXIST, 'EEXIST', '/');
    const parent = this.lookup(dirname(n));
    if (!parent || parent.type !== 'dir') throw new VfsError(E.NOENT, 'ENOENT', dirname(n));
    const name = basename(n);
    if (parent.children.has(name)) throw new VfsError(E.EXIST, 'EEXIST', n);
    parent.children.set(name, newDir(this.newTime()));
  }

  /** Create a directory and any missing parents (mkdir -p). */
  mkdirp(path: string): void {
    const n = normalize(path);
    let cur = this.root;
    for (const seg of n.slice(1).split('/')) {
      if (seg === '') continue;
      let next = cur.children.get(seg);
      if (!next) {
        next = newDir(this.newTime());
        cur.children.set(seg, next);
      } else if (next.type !== 'dir') {
        throw new VfsError(E.NOTDIR, 'ENOTDIR', n);
      }
      cur = next;
    }
  }

  rmdir(path: string): void {
    const node = this.lookup(path);
    if (!node) throw new VfsError(E.NOENT, 'ENOENT', path);
    if (node.type !== 'dir') throw new VfsError(E.NOTDIR, 'ENOTDIR', path);
    if (node.children.size > 0) throw new VfsError(E.INVAL, 'ENOTEMPTY', path);
    this.unlinkEntry(path);
  }

  /** List a directory's entries (names only), sorted. */
  readdir(path: string): string[] {
    const node = this.lookup(path);
    if (!node) throw new VfsError(E.NOENT, 'ENOENT', path);
    if (node.type !== 'dir') throw new VfsError(E.NOTDIR, 'ENOTDIR', path);
    return [...node.children.keys()].sort();
  }

  // -- files ----------------------------------------------------------------

  private parentDir(path: string): VNode {
    const parent = this.lookup(dirname(path));
    if (!parent) throw new VfsError(E.NOENT, 'ENOENT', dirname(path));
    if (parent.type !== 'dir') throw new VfsError(E.NOTDIR, 'ENOTDIR', dirname(path));
    return parent;
  }

  /** Create (or truncate) a file and return its node. */
  createFile(path: string, data: Uint8Array = new Uint8Array(0)): VNode {
    const parent = this.parentDir(path);
    const name = basename(path);
    const existing = parent.children.get(name);
    if (existing) {
      if (existing.type !== 'file') throw new VfsError(E.ISDIR, 'EISDIR', path);
      existing.data = data;
      existing.mtime = this.newTime();
      return existing;
    }
    const node: VNode = { type: 'file', data, children: new Map(), mode: 0o644, mtime: this.newTime() };
    parent.children.set(name, node);
    return node;
  }

  /** Read a whole file's bytes. */
  readFile(path: string): Uint8Array {
    const node = this.lookup(path);
    if (!node) throw new VfsError(E.NOENT, 'ENOENT', path);
    if (node.type === 'dir') throw new VfsError(E.ISDIR, 'EISDIR', path);
    return node.data;
  }

  /** Read a file as UTF-8 text (for source files / headers). */
  readText(path: string): string {
    return decoder.decode(this.readFile(path));
  }

  /** Write bytes, creating the file if needed. */
  writeFile(path: string, data: Uint8Array): void {
    this.createFile(path, data);
  }

  /** Write UTF-8 text, creating the file if needed. */
  writeText(path: string, text: string): void {
    this.createFile(path, encoder.encode(text));
  }

  /** Replace a file node's data in place (used by the fd write path). */
  setData(path: string, data: Uint8Array): void {
    const node = this.lookup(path);
    if (!node || node.type !== 'file') throw new VfsError(E.NOENT, 'ENOENT', path);
    node.data = data;
    node.mtime = this.newTime();
  }

  node(path: string): VNode | null {
    return this.lookup(path);
  }

  unlink(path: string): void {
    const node = this.lookup(path);
    if (!node) throw new VfsError(E.NOENT, 'ENOENT', path);
    if (node.type === 'dir') throw new VfsError(E.ISDIR, 'EISDIR', path);
    this.unlinkEntry(path);
  }

  rename(from: string, to: string): void {
    const node = this.lookup(from);
    if (!node) throw new VfsError(E.NOENT, 'ENOENT', from);
    const destParent = this.parentDir(to);
    this.unlinkEntry(from);
    destParent.children.set(basename(to), node);
  }

  private unlinkEntry(path: string): void {
    const parent = this.parentDir(path);
    parent.children.delete(basename(path));
  }

  // -- project sync ---------------------------------------------------------

  /** Load a name→text map (project files) under a base dir, e.g. "/home". */
  load(files: Record<string, string>, base = '/home'): void {
    for (const [name, text] of Object.entries(files)) {
      const path = name.startsWith('/') ? name : normalize(base + '/' + name);
      this.mkdirp(dirname(path));
      this.writeText(path, text);
    }
  }

  /** Export all files (absolute path → text) for saving back to the project. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (node: VNode, path: string): void => {
      for (const [name, child] of node.children) {
        const p = path === '/' ? '/' + name : path + '/' + name;
        if (child.type === 'file') out[p] = decoder.decode(child.data);
        else walk(child, p);
      }
    };
    walk(this.root, '/');
    return out;
  }
}

function newDir(mtime = 0): VNode {
  return { type: 'dir', data: new Uint8Array(0), children: new Map(), mode: 0o755, mtime };
}
