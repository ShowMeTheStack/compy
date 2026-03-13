/**
 * The I/O console — the terminal a running C program talks to. stdout/stderr
 * bytes land here; stdin is a byte queue the program pulls from (getchar,
 * scanf, read(0, …)). DOM-free: the IDE subscribes to output and pushes input.
 */

export type Stream = 'out' | 'err';

export interface ConsoleChunk {
  stream: Stream;
  text: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class Console {
  /** Everything written, in order, for replay/tests. */
  readonly chunks: ConsoleChunk[] = [];
  private outListeners: Array<(c: ConsoleChunk) => void> = [];
  /** Pending stdin bytes. */
  private input: number[] = [];
  /** Resolvers waiting for input when the queue is empty. */
  private waiters: Array<() => void> = [];
  /** Set when the input stream is closed (Ctrl-D / EOF). */
  private eof = false;

  // -- output ---------------------------------------------------------------

  writeBytes(stream: Stream, bytes: Uint8Array): void {
    this.write(stream, decoder.decode(bytes));
  }

  write(stream: Stream, text: string): void {
    const chunk: ConsoleChunk = { stream, text };
    this.chunks.push(chunk);
    for (const l of this.outListeners) l(chunk);
  }

  onOutput(fn: (c: ConsoleChunk) => void): () => void {
    this.outListeners.push(fn);
    return () => {
      this.outListeners = this.outListeners.filter((l) => l !== fn);
    };
  }

  /** Full stdout text (tests, oracle comparison). */
  stdout(): string {
    return this.chunks
      .filter((c) => c.stream === 'out')
      .map((c) => c.text)
      .join('');
  }

  stderr(): string {
    return this.chunks
      .filter((c) => c.stream === 'err')
      .map((c) => c.text)
      .join('');
  }

  // -- input ----------------------------------------------------------------

  /** Push user input (from the IDE) into the stdin queue. */
  feed(text: string): void {
    for (const b of encoder.encode(text)) this.input.push(b);
    this.wake();
  }

  feedBytes(bytes: Uint8Array): void {
    for (const b of bytes) this.input.push(b);
    this.wake();
  }

  /** Close stdin so future reads see EOF. */
  closeInput(): void {
    this.eof = true;
    this.wake();
  }

  hasInput(): boolean {
    return this.input.length > 0;
  }

  atEof(): boolean {
    return this.eof && this.input.length === 0;
  }

  /** Take up to n bytes without blocking; returns [] if none buffered. */
  readAvailable(n: number): number[] {
    return this.input.splice(0, n);
  }

  /**
   * Read one byte, awaiting input if the queue is empty. Resolves to -1 on EOF.
   * Interpreters that run synchronously can instead poll hasInput()/readAvailable().
   */
  async readByte(): Promise<number> {
    while (this.input.length === 0) {
      if (this.eof) return -1;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.input.shift()!;
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }

  reset(): void {
    this.chunks.length = 0;
    this.input.length = 0;
    this.waiters.length = 0;
    this.eof = false;
  }
}
