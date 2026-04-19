import type { Span, Pos } from './token';

/**
 * A compiler diagnostic. `error` stops compilation; `warning` is advisory
 * (non-C89 constructs, dubious code); in strict mode the driver promotes the
 * flagged warnings to errors.
 */
export type Severity = 'error' | 'warning' | 'note';

export interface Diagnostic {
  severity: Severity;
  message: string;
  span: Span;
  /** Stable tag so the driver can filter/promote (e.g. 'ext/line-comment'). */
  code?: string;
}

export class CompileError extends Error {
  constructor(
    message: string,
    readonly span: Span,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CompileError';
  }
}

export function pos(file: string, line: number, col: number, offset: number): Pos {
  return { file, line, col, offset };
}

export function span(start: Pos, end: Pos): Span {
  return { start, end };
}
