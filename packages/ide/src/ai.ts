import type { ChatMessage } from './assistant';

/**
 * AI engine registry. A single optional engine powers richer chat and inline
 * "ghost text" completion; everything falls back to the offline assistant when
 * it isn't present. The engine is injected (neural.ts loads the real
 * transformers.js one, tests use a fake), so all the wiring is testable without
 * downloading a model.
 */

export interface AiEngine {
  chat(query: string, history: ChatMessage[]): Promise<string>;
  complete(before: string, after: string): Promise<string>;
}

export type AiState = 'absent' | 'loading' | 'ready' | 'error';

export interface AiSnapshot {
  state: AiState;
  label: string;
  detail: string;
  progress: number;
  ready: boolean;
}

let engine: AiEngine | null = null;
let state: AiState = 'absent';
let label = '';
let detail = '';
let progress = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function getEngine(): AiEngine | null {
  return engine;
}

let snapshot: AiSnapshot = { state, label, detail, progress, ready: false };
export function aiStatus(): AiSnapshot {
  return snapshot;
}

function refresh(): void {
  snapshot = { state, label, detail, progress, ready: state === 'ready' && !!engine };
  emit();
}

export function subscribeAi(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setEngine(e: AiEngine, name = 'AI model'): void {
  engine = e;
  state = 'ready';
  label = name;
  detail = '';
  progress = 0;
  refresh();
}

export function setAiStatus(s: AiState, detailText = '', name = label): void {
  state = s;
  detail = detailText;
  label = name;
  if (s !== 'loading') progress = 0;
  if (s !== 'ready') engine = null;
  refresh();
}

export function setAiProgress(frac: number, detailText: string): void {
  state = 'loading';
  progress = Math.max(0, Math.min(1, frac));
  detail = detailText;
  refresh();
}

// Test / integration hook: lets an injected engine drive the whole UI.
if (typeof window !== 'undefined') {
  (window as unknown as { __compyAI?: unknown }).__compyAI = { setEngine, setAiStatus, setAiProgress, getEngine };
}
