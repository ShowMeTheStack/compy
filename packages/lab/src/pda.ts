import { Grammar, isTerminal, fmtRhs } from './grammar';
import { LabToken } from './lexer';

/**
 * CFG → PDA by the textbook construction (Sipser): three states. From
 * q_start push $ and the start symbol; in q_loop either expand the
 * nonterminal on top by a production or match the terminal on top against
 * the input; on $ with the input exhausted, accept. The PDA is
 * nondeterministic, so the stepper simulates the set of configurations.
 */
export interface PdaTransition {
  id: number;
  from: string;
  to: string;
  /** Input symbol read, or null for ε. */
  read: string | null;
  /** Stack symbol popped, or null for ε. */
  pop: string | null;
  /** Symbols pushed (top first), empty for ε. */
  push: string[];
  label: string;
  production?: number;
}
export interface Pda {
  states: string[];
  start: string;
  accept: string;
  transitions: PdaTransition[];
}

export function cfgToPda(g: Grammar): Pda {
  const t: PdaTransition[] = [];
  const add = (x: Omit<PdaTransition, 'id' | 'label'>) => {
    const label = `${x.read ?? 'ε'}, ${x.pop ?? 'ε'} → ${x.push.length ? x.push.join('') : 'ε'}`;
    t.push({ id: t.length, label, ...x });
  };
  add({ from: 'q_start', to: 'q_loop', read: null, pop: null, push: [g.start, '$'] });
  for (const p of g.productions) add({ from: 'q_loop', to: 'q_loop', read: null, pop: p.lhs, push: p.rhs.slice(), production: p.id });
  for (const a of g.terminals) add({ from: 'q_loop', to: 'q_loop', read: a, pop: a, push: [] });
  add({ from: 'q_loop', to: 'q_accept', read: null, pop: '$', push: [] });
  return { states: ['q_start', 'q_loop', 'q_accept'], start: 'q_start', accept: 'q_accept', transitions: t };
}

export interface PdaConfig {
  id: number;
  state: string;
  pos: number;
  /** Stack, top first. */
  stack: string[];
  parent: number | null;
  via: number | null;
}

export interface PdaRun {
  /** The frontier after each step (step 0 = initial configuration). */
  frontiers: PdaConfig[][];
  accepted: boolean;
  /** The configurations along one accepting path, if any. */
  path: PdaConfig[];
  truncated: boolean;
}

/** Breadth-first simulation of the nondeterministic PDA. */
export function runPda(pda: Pda, g: Grammar, tokens: LabToken[], opts: { maxFrontier?: number; maxSteps?: number } = {}): PdaRun {
  const maxFrontier = opts.maxFrontier ?? 2000;
  const maxSteps = opts.maxSteps ?? 400;
  const input = tokens.map((t) => t.name);
  let nextId = 0;
  const all = new Map<number, PdaConfig>();
  const mk = (state: string, pos: number, stack: string[], parent: number | null, via: number | null): PdaConfig => {
    const c = { id: nextId++, state, pos, stack, parent, via };
    all.set(c.id, c);
    return c;
  };
  const key = (c: PdaConfig) => `${c.state}|${c.pos}|${c.stack.join(' ')}`;
  let frontier = [mk(pda.start, 0, [], null, null)];
  const frontiers: PdaConfig[][] = [frontier];
  const seen = new Set<string>([key(frontier[0]!)]);
  let accepted: PdaConfig | null = null;
  let truncated = false;
  for (let step = 0; step < maxSteps && frontier.length && !accepted; step++) {
    const next: PdaConfig[] = [];
    for (const c of frontier) {
      if (c.state === pda.accept && c.pos === input.length) {
        accepted = c;
        break;
      }
      for (const t of pda.transitions) {
        if (t.from !== c.state) continue;
        if (t.read !== null && input[c.pos] !== t.read) continue;
        if (t.pop !== null && c.stack[0] !== t.pop) continue;
        // Expanding a nonterminal makes the stack grow: bound it by remaining input (plus slack).
        const stack = [...t.push, ...c.stack.slice(t.pop !== null ? 1 : 0)];
        const nonEpsilon = stack.filter((s) => !isTerminal(g, s) ? false : true).length;
        if (nonEpsilon > input.length - c.pos + 1 && !pdaHasNullable(g)) continue;
        if (stack.length > input.length * 4 + 8) continue;
        const n = mk(t.to, c.pos + (t.read !== null ? 1 : 0), stack, c.id, t.id);
        const k = key(n);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(n);
        if (next.length >= maxFrontier) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (accepted) break;
    frontier = next;
    frontiers.push(frontier);
  }
  if (!accepted) {
    const last = frontiers[frontiers.length - 1] ?? [];
    accepted = last.find((c) => c.state === pda.accept && c.pos === input.length) ?? null;
  }
  const path: PdaConfig[] = [];
  for (let c: PdaConfig | null = accepted; c; c = c.parent === null ? null : all.get(c.parent) ?? null) path.unshift(c);
  return { frontiers, accepted: accepted !== null, path, truncated };
}

let nullableCache = new WeakMap<Grammar, boolean>();
function pdaHasNullable(g: Grammar): boolean {
  const c = nullableCache.get(g);
  if (c !== undefined) return c;
  const v = g.productions.some((p) => p.rhs.length === 0);
  nullableCache.set(g, v);
  return v;
}

export function fmtPdaConfig(c: PdaConfig, tokens: LabToken[]): string {
  return `(${c.state}, ${tokens.slice(c.pos).map((t) => t.name).join(' ') || 'ε'}, ${c.stack.join('') || 'ε'})`;
}

export { fmtRhs };
