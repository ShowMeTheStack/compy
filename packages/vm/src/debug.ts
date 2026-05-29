import { DebugController, Interp, StackFrame, VarView } from './interp';

/**
 * The debugger engine. Implements the interpreter's DebugController hook to
 * provide breakpoints and step in / over / out, a live call stack, and locals.
 * Execution is synchronous, so `onPause` is called at each stop and the handler
 * chooses the next action inline (continue/stepIn/stepOver/stepOut) — in the
 * IDE the interpreter runs in a worker and the handler blocks until the user
 * clicks; in tests the handler scripts the session.
 */

export type StepMode = 'run' | 'stepIn' | 'stepOver' | 'stepOut' | 'paused';

export interface StopEvent {
  reason: 'breakpoint' | 'step' | 'pause';
  line: number;
  file: string;
  func: string;
  depth: number;
  callStack: StackFrame[];
  locals: VarView[];
}

export type PauseHandler = (dbg: Debugger, event: StopEvent, interp: Interp) => void;

export class Debugger implements DebugController {
  private breakpoints = new Set<string>();
  private mode: StepMode = 'run';
  private stepDepth = 0;
  onPause: PauseHandler | null = null;
  /** Every stop, in order — convenient for headless assertions. */
  readonly history: StopEvent[] = [];

  // -- breakpoints -----------------------------------------------------------

  /** Add a breakpoint at a line (in a specific file, or any file with '*'). */
  addBreakpoint(line: number, file = '*'): void {
    this.breakpoints.add(`${file}:${line}`);
  }
  removeBreakpoint(line: number, file = '*'): void {
    this.breakpoints.delete(`${file}:${line}`);
  }
  clearBreakpoints(): void {
    this.breakpoints.clear();
  }
  hasBreakpoint(line: number, file = '*'): boolean {
    return this.breakpoints.has(`${file}:${line}`) || this.breakpoints.has(`*:${line}`);
  }

  // -- resume commands (call from the pause handler) -------------------------

  continue_(): void {
    this.mode = 'run';
  }
  stepIn(): void {
    this.mode = 'stepIn';
  }
  stepOver(): void {
    this.mode = 'stepOver';
  }
  stepOut(): void {
    this.mode = 'stepOut';
  }
  /** Pause at the very next statement. */
  pauseNext(): void {
    this.mode = 'paused';
  }

  // -- the interpreter hook --------------------------------------------------

  before(interp: Interp, line: number, file: string): void {
    const depth = interp.callDepth();
    const bp = this.breakpoints.has(`${file}:${line}`) || this.breakpoints.has(`*:${line}`);
    let reason: StopEvent['reason'] | null = null;
    if (bp) reason = 'breakpoint';
    else if (this.mode === 'stepIn') reason = 'step';
    else if (this.mode === 'stepOver' && depth <= this.stepDepth) reason = 'step';
    else if (this.mode === 'stepOut' && depth < this.stepDepth) reason = 'step';
    else if (this.mode === 'paused') reason = 'pause';
    if (!reason) return;

    this.stepDepth = depth;
    const event: StopEvent = {
      reason,
      line,
      file,
      func: interp.callStack[depth - 1]?.name ?? '',
      depth,
      callStack: interp.callStack.map((f) => ({ ...f })),
      locals: interp.frameVars(),
    };
    this.history.push(event);
    // Default to staying paused until the handler chooses a resume command.
    this.mode = 'paused';
    if (this.onPause) this.onPause(this, event, interp);
  }
}
