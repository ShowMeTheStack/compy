/**
 * Regular expressions the textbook way: parse a pattern into a syntax tree,
 * build an NFA by Thompson's construction, convert it to a DFA by subset
 * construction, and minimize with Hopcroft's algorithm. Every construction
 * keeps the intermediate data (epsilon closures, subset table, partitions)
 * so the lab can draw and step through it.
 *
 * Dialect: literals, escapes (\n \t \\ \. …), `.`, character classes
 * [a-z0-9_] with negation, groups, alternation `|`, and `* + ?`. No
 * backreferences or lookaround: those are not regular languages.
 */

export type RegexNode =
  | { kind: 'char'; set: CharSet; text: string }
  | { kind: 'empty' }
  | { kind: 'concat'; items: RegexNode[] }
  | { kind: 'alt'; items: RegexNode[] }
  | { kind: 'star' | 'plus' | 'opt'; item: RegexNode };

/** A set of characters: explicit code points, ranges, optionally negated. */
export interface CharSet {
  ranges: [number, number][];
  negated: boolean;
}

export class RegexSyntaxError extends Error {
  constructor(message: string, readonly at: number) {
    super(message);
  }
}

export function parseRegex(src: string): RegexNode {
  let i = 0;
  const peek = () => src[i];
  const eat = () => src[i++];
  const parseAlt = (): RegexNode => {
    const items = [parseConcat()];
    while (peek() === '|') {
      eat();
      items.push(parseConcat());
    }
    return items.length === 1 ? items[0]! : { kind: 'alt', items };
  };
  const parseConcat = (): RegexNode => {
    const items: RegexNode[] = [];
    while (i < src.length && peek() !== '|' && peek() !== ')') items.push(parseRepeat());
    return items.length === 1 ? items[0]! : items.length === 0 ? { kind: 'empty' } : { kind: 'concat', items };
  };
  const parseRepeat = (): RegexNode => {
    let atom = parseAtom();
    for (;;) {
      const c = peek();
      if (c === '*') { eat(); atom = { kind: 'star', item: atom }; }
      else if (c === '+') { eat(); atom = { kind: 'plus', item: atom }; }
      else if (c === '?') { eat(); atom = { kind: 'opt', item: atom }; }
      else return atom;
    }
  };
  const parseAtom = (): RegexNode => {
    const c = eat();
    if (c === undefined) throw new RegexSyntaxError('unexpected end of pattern', i);
    if (c === '(') {
      const inner = parseAlt();
      if (eat() !== ')') throw new RegexSyntaxError("expected ')'", i);
      return inner;
    }
    if (c === '[') return parseClass();
    if (c === '.') return { kind: 'char', set: { ranges: [[0, 0x10ffff]], negated: false }, text: '.' };
    if (c === '\\') {
      const e = eat();
      if (e === undefined) throw new RegexSyntaxError('dangling backslash', i);
      const esc = escapeClass(e);
      if (esc) return { kind: 'char', set: esc, text: '\\' + e };
      const code = escapeChar(e);
      return { kind: 'char', set: { ranges: [[code, code]], negated: false }, text: '\\' + e };
    }
    if (c === '*' || c === '+' || c === '?') throw new RegexSyntaxError(`nothing to repeat before '${c}'`, i);
    const code = c.codePointAt(0)!;
    return { kind: 'char', set: { ranges: [[code, code]], negated: false }, text: c };
  };
  const parseClass = (): RegexNode => {
    const start = i - 1;
    let negated = false;
    if (peek() === '^') { eat(); negated = true; }
    const ranges: [number, number][] = [];
    let first = true;
    while (i < src.length && (peek() !== ']' || first)) {
      first = false;
      let c = eat()!;
      let lo: number;
      if (c === '\\') {
        const e = eat();
        if (e === undefined) throw new RegexSyntaxError('dangling backslash in class', i);
        const esc = escapeClass(e);
        if (esc) { ranges.push(...esc.ranges); continue; }
        lo = escapeChar(e);
      } else lo = c.codePointAt(0)!;
      if (peek() === '-' && src[i + 1] !== undefined && src[i + 1] !== ']') {
        eat();
        c = eat()!;
        let hi: number;
        if (c === '\\') hi = escapeChar(eat() ?? '\\');
        else hi = c.codePointAt(0)!;
        if (hi < lo) throw new RegexSyntaxError('bad range in class', i);
        ranges.push([lo, hi]);
      } else ranges.push([lo, lo]);
    }
    if (eat() !== ']') throw new RegexSyntaxError("expected ']'", i);
    return { kind: 'char', set: { ranges, negated }, text: src.slice(start, i) };
  };
  const node = parseAlt();
  if (i < src.length) throw new RegexSyntaxError(`unexpected '${src[i]}'`, i);
  return node;
}

function escapeChar(e: string): number {
  switch (e) {
    case 'n': return 10;
    case 't': return 9;
    case 'r': return 13;
    case '0': return 0;
    default: return e.codePointAt(0)!;
  }
}
function escapeClass(e: string): CharSet | null {
  switch (e) {
    case 'd': return { ranges: [[48, 57]], negated: false };
    case 'w': return { ranges: [[48, 57], [65, 90], [95, 95], [97, 122]], negated: false };
    case 's': return { ranges: [[9, 13], [32, 32]], negated: false };
    case 'D': return { ranges: [[48, 57]], negated: true };
    case 'W': return { ranges: [[48, 57], [65, 90], [95, 95], [97, 122]], negated: true };
    case 'S': return { ranges: [[9, 13], [32, 32]], negated: true };
    default: return null;
  }
}

export function charSetHas(set: CharSet, code: number): boolean {
  let inside = false;
  for (const [lo, hi] of set.ranges) if (code >= lo && code <= hi) { inside = true; break; }
  return set.negated ? !inside : inside;
}

export function fmtRegex(n: RegexNode): string {
  switch (n.kind) {
    case 'char': return n.text;
    case 'empty': return 'ε';
    case 'concat': return n.items.map((x) => (x.kind === 'alt' ? `(${fmtRegex(x)})` : fmtRegex(x))).join('');
    case 'alt': return n.items.map(fmtRegex).join('|');
    case 'star': case 'plus': case 'opt': {
      const inner = n.item.kind === 'concat' || n.item.kind === 'alt' ? `(${fmtRegex(n.item)})` : fmtRegex(n.item);
      return inner + (n.kind === 'star' ? '*' : n.kind === 'plus' ? '+' : '?');
    }
  }
}

// -- NFA (Thompson) --------------------------------------------------------------

export interface NfaEdge {
  from: number;
  to: number;
  /** null = epsilon. */
  set: CharSet | null;
  label: string;
}
export interface Nfa {
  states: number;
  start: number;
  /** Accepting states → rule id (for a combined scanner NFA). */
  accept: Map<number, number>;
  edges: NfaEdge[];
}

export function thompson(re: RegexNode, acceptId = 0): Nfa {
  const edges: NfaEdge[] = [];
  let n = 0;
  const fresh = () => n++;
  const eps = (from: number, to: number) => edges.push({ from, to, set: null, label: 'ε' });
  const build = (node: RegexNode): [number, number] => {
    switch (node.kind) {
      case 'char': {
        const s = fresh();
        const t = fresh();
        edges.push({ from: s, to: t, set: node.set, label: node.text });
        return [s, t];
      }
      case 'empty': {
        const s = fresh();
        const t = fresh();
        eps(s, t);
        return [s, t];
      }
      case 'concat': {
        const parts = node.items.map(build);
        for (let k = 0; k + 1 < parts.length; k++) eps(parts[k]![1], parts[k + 1]![0]);
        return [parts[0]![0], parts[parts.length - 1]![1]];
      }
      case 'alt': {
        const s = fresh();
        const t = fresh();
        for (const item of node.items) {
          const [a, b] = build(item);
          eps(s, a);
          eps(b, t);
        }
        return [s, t];
      }
      case 'star': {
        const s = fresh();
        const t = fresh();
        const [a, b] = build(node.item);
        eps(s, a);
        eps(b, a);
        eps(s, t);
        eps(b, t);
        return [s, t];
      }
      case 'plus': {
        const s = fresh();
        const t = fresh();
        const [a, b] = build(node.item);
        eps(s, a);
        eps(b, a);
        eps(b, t);
        return [s, t];
      }
      case 'opt': {
        const s = fresh();
        const t = fresh();
        const [a, b] = build(node.item);
        eps(s, a);
        eps(b, t);
        eps(s, t);
        return [s, t];
      }
    }
  };
  const [start, end] = build(re);
  return { states: n, start, accept: new Map([[end, acceptId]]), edges };
}

/** One NFA for several rules: a new start state with ε-edges into each rule's NFA. */
export function combineNfas(nfas: Nfa[]): Nfa {
  const edges: NfaEdge[] = [];
  const accept = new Map<number, number>();
  let offset = 1;
  for (const nfa of nfas) {
    edges.push({ from: 0, to: nfa.start + offset, set: null, label: 'ε' });
    for (const e of nfa.edges) edges.push({ ...e, from: e.from + offset, to: e.to + offset });
    for (const [s, id] of nfa.accept) accept.set(s + offset, id);
    offset += nfa.states;
  }
  return { states: offset, start: 0, accept, edges };
}

export function epsilonClosure(nfa: Nfa, states: Iterable<number>): Set<number> {
  const out = new Set<number>(states);
  const work = [...out];
  while (work.length) {
    const s = work.pop()!;
    for (const e of nfa.edges) if (e.from === s && e.set === null && !out.has(e.to)) {
      out.add(e.to);
      work.push(e.to);
    }
  }
  return out;
}

export function nfaMove(nfa: Nfa, states: Set<number>, code: number): Set<number> {
  const out = new Set<number>();
  for (const e of nfa.edges) if (states.has(e.from) && e.set !== null && charSetHas(e.set, code)) out.add(e.to);
  return out;
}

/** Simulate the NFA on a string, recording the active set after each character. */
export function nfaRun(nfa: Nfa, input: string): { accepted: boolean; ruleId: number | null; sets: Set<number>[] } {
  let cur = epsilonClosure(nfa, [nfa.start]);
  const sets = [cur];
  for (const ch of input) {
    cur = epsilonClosure(nfa, nfaMove(nfa, cur, ch.codePointAt(0)!));
    sets.push(cur);
  }
  const rule = acceptOf(nfa, cur);
  return { accepted: rule !== null, ruleId: rule, sets };
}

function acceptOf(nfa: Nfa, set: Set<number>): number | null {
  let best: number | null = null;
  for (const s of set) {
    const id = nfa.accept.get(s);
    if (id !== undefined && (best === null || id < best)) best = id; // lower rule id wins
  }
  return best;
}

// -- DFA (subset construction) ---------------------------------------------------

export interface DfaEdge {
  from: number;
  to: number;
  set: CharSet;
  label: string;
}
export interface Dfa {
  states: number;
  start: number;
  accept: Map<number, number>;
  edges: DfaEdge[];
  /** For subset-constructed DFAs: the NFA states each DFA state stands for. */
  subsets: number[][];
  /** The alphabet partition used for transitions (disjoint ranges). */
  alphabet: [number, number][];
}

/** Split all character sets in the NFA into disjoint ranges (the DFA alphabet). */
function alphabetOf(nfa: Nfa): [number, number][] {
  const points = new Set<number>([0, 0x110000]);
  for (const e of nfa.edges) {
    if (!e.set) continue;
    for (const [lo, hi] of e.set.ranges) {
      points.add(lo);
      points.add(hi + 1);
    }
  }
  const sorted = [...points].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < sorted.length; k++) out.push([sorted[k]!, sorted[k + 1]! - 1]);
  // Keep only ranges some edge actually accepts.
  return out.filter(([lo]) => nfa.edges.some((e) => e.set && charSetHas(e.set, lo)));
}

export function subsetConstruction(nfa: Nfa): Dfa {
  const alphabet = alphabetOf(nfa);
  const key = (s: Set<number>) => [...s].sort((a, b) => a - b).join(',');
  const subsets: number[][] = [];
  const index = new Map<string, number>();
  const edges: DfaEdge[] = [];
  const accept = new Map<number, number>();
  const startSet = epsilonClosure(nfa, [nfa.start]);
  index.set(key(startSet), 0);
  subsets.push([...startSet].sort((a, b) => a - b));
  const work = [0];
  while (work.length) {
    const d = work.shift()!;
    const set = new Set(subsets[d]!);
    const rule = acceptOf(nfa, set);
    if (rule !== null) accept.set(d, rule);
    // Group alphabet ranges by target subset so edges carry merged labels.
    const byTarget = new Map<number, [number, number][]>();
    for (const [lo, hi] of alphabet) {
      const moved = epsilonClosure(nfa, nfaMove(nfa, set, lo));
      if (moved.size === 0) continue;
      const k = key(moved);
      let t = index.get(k);
      if (t === undefined) {
        t = subsets.length;
        index.set(k, t);
        subsets.push([...moved].sort((a, b) => a - b));
        work.push(t);
      }
      byTarget.set(t, [...(byTarget.get(t) ?? []), [lo, hi]]);
    }
    for (const [t, ranges] of byTarget) edges.push({ from: d, to: t, set: { ranges: mergeRanges(ranges), negated: false }, label: fmtRanges(mergeRanges(ranges)) });
  }
  return { states: subsets.length, start: 0, accept, edges, subsets, alphabet };
}

function mergeRanges(r: [number, number][]): [number, number][] {
  const s = r.slice().sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1] + 1) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

export function fmtRanges(ranges: [number, number][]): string {
  const show = (c: number) => {
    if (c === 10) return '\\n';
    if (c === 9) return '\\t';
    if (c === 32) return '␣';
    if (c === 0x10ffff) return '∞';
    if (c < 32 || c > 126) return `\\x${c.toString(16)}`;
    return String.fromCodePoint(c);
  };
  return ranges.map(([lo, hi]) => (lo === hi ? show(lo) : `${show(lo)}-${show(hi)}`)).join(' ');
}

export function dfaStep(dfa: Dfa, state: number, code: number): number | null {
  for (const e of dfa.edges) if (e.from === state && charSetHas(e.set, code)) return e.to;
  return null;
}

export function dfaRun(dfa: Dfa, input: string): { accepted: boolean; ruleId: number | null; path: (number | null)[] } {
  let s: number | null = dfa.start;
  const path: (number | null)[] = [s];
  for (const ch of input) {
    if (s === null) break;
    s = dfaStep(dfa, s, ch.codePointAt(0)!);
    path.push(s);
  }
  const rule = s === null ? null : dfa.accept.get(s) ?? null;
  return { accepted: rule !== null, ruleId: rule, path };
}

// -- Minimization (Hopcroft) --------------------------------------------------------

export interface MinimizeResult {
  dfa: Dfa;
  /** Old state → new state. */
  mapping: number[];
  /** Partition refinement history for display. */
  rounds: number[][][];
}

export function minimize(dfa: Dfa): MinimizeResult {
  // Make the DFA total over its alphabet with an implicit dead state (-1).
  const alphabet = dfa.alphabet;
  const trans = (s: number, lo: number): number => (s < 0 ? -1 : dfaStep(dfa, s, lo) ?? -1);
  // Initial partition: by accepting rule id (and the dead state).
  const groupOf = new Map<number, number>();
  const groups: number[][] = [];
  const keyOf = (s: number) => (s < 0 ? 'dead' : `acc${dfa.accept.get(s) ?? '-'}`);
  const byKey = new Map<string, number>();
  for (let s = -1; s < dfa.states; s++) {
    const k = keyOf(s);
    let g = byKey.get(k);
    if (g === undefined) {
      g = groups.length;
      byKey.set(k, g);
      groups.push([]);
    }
    groups[g]!.push(s);
    groupOf.set(s, g);
  }
  const rounds: number[][][] = [groups.map((g) => g.filter((s) => s >= 0))];
  let changed = true;
  while (changed) {
    changed = false;
    const next: number[][] = [];
    const nextOf = new Map<number, number>();
    for (const g of groups) {
      const sig = new Map<string, number[]>();
      for (const s of g) {
        const k = alphabet.map(([lo]) => groupOf.get(trans(s, lo))).join(',');
        sig.set(k, [...(sig.get(k) ?? []), s]);
      }
      if (sig.size > 1) changed = true;
      for (const part of sig.values()) {
        for (const s of part) nextOf.set(s, next.length);
        next.push(part);
      }
    }
    groups.length = 0;
    groups.push(...next);
    for (const [s, g] of nextOf) groupOf.set(s, g);
    if (changed) rounds.push(groups.map((g) => g.filter((s) => s >= 0)));
  }
  // Build the minimized DFA (drop the dead group).
  const live = groups.filter((g) => !g.includes(-1) || g.length > 1).map((g) => g.filter((s) => s >= 0)).filter((g) => g.length);
  const newIndex = new Map<number, number>();
  live.forEach((g, k) => g.forEach((s) => newIndex.set(s, k)));
  const startNew = newIndex.get(dfa.start)!;
  // Reorder so the start state is 0.
  const order = [startNew, ...live.map((_, k) => k).filter((k) => k !== startNew)];
  const rename = new Map(order.map((old, k) => [old, k] as const));
  const mapping = Array.from({ length: dfa.states }, (_, s) => rename.get(newIndex.get(s)!)!);
  const edges: DfaEdge[] = [];
  const seen = new Set<string>();
  for (const e of dfa.edges) {
    const f = mapping[e.from]!;
    const t = mapping[e.to]!;
    const k = `${f}>${t}`;
    const existing = edges.find((x) => x.from === f && x.to === t);
    if (existing) {
      existing.set = { ranges: mergeRanges([...existing.set.ranges, ...e.set.ranges]), negated: false };
      existing.label = fmtRanges(existing.set.ranges);
    } else if (!seen.has(k)) {
      seen.add(k);
      edges.push({ from: f, to: t, set: { ranges: e.set.ranges.slice(), negated: false }, label: e.label });
    }
  }
  const accept = new Map<number, number>();
  for (const [s, id] of dfa.accept) accept.set(mapping[s]!, id);
  const subsets: number[][] = order.map((old) => live[old]!);
  return { dfa: { states: live.length, start: 0, accept, edges, subsets, alphabet }, mapping, rounds };
}
