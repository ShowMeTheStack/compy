import { Grammar, Production, analyzeGrammar, isTerminal, fmtGrammar } from './grammar';

/**
 * The classic grammar transformations. Each returns a new grammar plus
 * human-readable notes, and the UI shows the before/after as a diff.
 */
export interface TransformResult {
  grammar: Grammar;
  notes: string[];
  before: string;
  after: string;
}

export type TransformId = 'epsilon' | 'unit' | 'useless' | 'left-recursion' | 'left-factor' | 'cnf' | 'augment';

export const TRANSFORMS: { id: TransformId; name: string; description: string }[] = [
  { id: 'epsilon', name: 'Remove ε-productions', description: 'For every nullable symbol, add copies of each production with that symbol omitted, then drop the ε-rules (keeping S -> ε only if the language contains the empty string).' },
  { id: 'unit', name: 'Remove unit productions', description: 'A -> B is replaced by copies of all of B’s productions under A, following chains transitively.' },
  { id: 'useless', name: 'Remove useless symbols', description: 'Drop nonterminals that can never derive a terminal string, then symbols unreachable from the start symbol.' },
  { id: 'left-recursion', name: 'Eliminate left recursion', description: 'A -> A α | β becomes A -> β A\', A\' -> α A\' | ε. Indirect left recursion is first made direct by substituting in a fixed nonterminal order (Paull’s algorithm).' },
  { id: 'left-factor', name: 'Left-factor', description: 'A -> α β | α γ becomes A -> α A\', A\' -> β | γ, so an LL(1) parser can decide after one token.' },
  { id: 'cnf', name: 'Convert to Chomsky normal form', description: 'Every production becomes A -> B C or A -> a (plus S -> ε if needed): new start, ε-removal, unit-removal, terminal isolation, binarisation. Required by CYK.' },
  { id: 'augment', name: 'Augment (S\' -> S)', description: 'Adds a new start symbol with a single production, the first step of every LR construction.' },
];

function clone(g: Grammar): Grammar {
  return { ...g, productions: g.productions.map((p) => ({ ...p, rhs: p.rhs.slice() })), nonterminals: g.nonterminals.slice(), terminals: g.terminals.slice(), literals: g.literals.slice(), errors: [] };
}

function rebuild(g: Grammar, prods: Production[], start = g.start): Grammar {
  const nonterminals: string[] = [];
  if (prods.some((p) => p.lhs === start)) nonterminals.push(start);
  for (const p of prods) if (!nonterminals.includes(p.lhs)) nonterminals.push(p.lhs);
  const terminals: string[] = [];
  for (const p of prods) for (const s of p.rhs) if (!nonterminals.includes(s) && !terminals.includes(s)) terminals.push(s);
  // Dedupe productions.
  const seen = new Set<string>();
  const unique: Production[] = [];
  for (const p of prods) {
    const k = p.lhs + '→' + p.rhs.join(' ');
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push({ ...p, id: unique.length });
  }
  return { ...g, start, productions: unique, nonterminals, terminals, errors: [] };
}

function freshName(g: Grammar, base: string, used: Set<string>): string {
  let name = base + "'";
  while (g.nonterminals.includes(name) || used.has(name)) name += "'";
  used.add(name);
  return name;
}

export function transform(g: Grammar, id: TransformId): TransformResult {
  const before = fmtGrammar(g);
  let r: { grammar: Grammar; notes: string[] };
  switch (id) {
    case 'epsilon': r = removeEpsilon(g); break;
    case 'unit': r = removeUnit(g); break;
    case 'useless': r = removeUseless(g); break;
    case 'left-recursion': r = eliminateLeftRecursion(g); break;
    case 'left-factor': r = leftFactor(g); break;
    case 'cnf': r = toCnf(g); break;
    case 'augment': r = augment(g); break;
  }
  return { grammar: r.grammar, notes: r.notes, before, after: fmtGrammar(r.grammar) };
}

export function removeEpsilon(g: Grammar): { grammar: Grammar; notes: string[] } {
  const an = analyzeGrammar(g);
  const notes: string[] = [];
  if (an.nullable.size === 0) return { grammar: clone(g), notes: ['no nullable nonterminals: nothing to do'] };
  notes.push(`nullable: ${[...an.nullable].join(', ')}`);
  const prods: Production[] = [];
  for (const p of g.productions) {
    // All subsets of nullable occurrences.
    const idx = p.rhs.map((s, k) => (an.nullable.has(s) ? k : -1)).filter((k) => k >= 0);
    const n = 1 << Math.min(idx.length, 12);
    for (let mask = 0; mask < n; mask++) {
      const rhs = p.rhs.filter((_, k) => {
        const j = idx.indexOf(k);
        return j < 0 || (mask & (1 << j)) === 0;
      });
      if (rhs.length === 0) continue;
      prods.push({ id: 0, lhs: p.lhs, rhs, line: p.line });
    }
  }
  if (an.nullable.has(g.start)) {
    prods.push({ id: 0, lhs: g.start, rhs: [], line: 0 });
    notes.push(`${g.start} is nullable, so ${g.start} -> ε is kept (the language contains the empty string)`);
  }
  return { grammar: rebuild(g, prods), notes };
}

export function removeUnit(g: Grammar): { grammar: Grammar; notes: string[] } {
  const notes: string[] = [];
  const unitClosure = new Map<string, Set<string>>();
  for (const a of g.nonterminals) {
    const set = new Set<string>([a]);
    const work = [a];
    while (work.length) {
      const b = work.pop()!;
      for (const p of g.productions) if (p.lhs === b && p.rhs.length === 1 && !isTerminal(g, p.rhs[0]!) && !set.has(p.rhs[0]!)) {
        set.add(p.rhs[0]!);
        work.push(p.rhs[0]!);
      }
    }
    unitClosure.set(a, set);
    if (set.size > 1) notes.push(`${a} reaches ${[...set].filter((x) => x !== a).join(', ')} through unit productions`);
  }
  const prods: Production[] = [];
  for (const a of g.nonterminals) {
    for (const b of unitClosure.get(a)!) {
      for (const p of g.productions) if (p.lhs === b && !(p.rhs.length === 1 && !isTerminal(g, p.rhs[0]!))) prods.push({ id: 0, lhs: a, rhs: p.rhs.slice(), line: p.line });
    }
  }
  if (!notes.length) notes.push('no unit productions');
  return { grammar: rebuild(g, prods), notes };
}

export function removeUseless(g: Grammar): { grammar: Grammar; notes: string[] } {
  const notes: string[] = [];
  const productive = new Set<string>(g.terminals);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of g.productions) if (!productive.has(p.lhs) && p.rhs.every((s) => productive.has(s))) {
      productive.add(p.lhs);
      changed = true;
    }
  }
  const dead = g.nonterminals.filter((n) => !productive.has(n));
  if (dead.length) notes.push(`unproductive, removed: ${dead.join(', ')}`);
  let prods = g.productions.filter((p) => productive.has(p.lhs) && p.rhs.every((s) => productive.has(s)));
  const reach = new Set<string>([g.start]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of prods) if (reach.has(p.lhs)) for (const s of p.rhs) if (!reach.has(s)) {
      reach.add(s);
      changed = true;
    }
  }
  const unreachable = g.nonterminals.filter((n) => productive.has(n) && !reach.has(n));
  if (unreachable.length) notes.push(`unreachable, removed: ${unreachable.join(', ')}`);
  prods = prods.filter((p) => reach.has(p.lhs));
  if (!notes.length) notes.push('every symbol is useful');
  return { grammar: rebuild(g, prods.map((p) => ({ ...p, rhs: p.rhs.slice() }))), notes };
}

export function eliminateLeftRecursion(g: Grammar): { grammar: Grammar; notes: string[] } {
  const notes: string[] = [];
  const used = new Set<string>();
  const order = g.nonterminals.slice();
  let prods: Production[] = g.productions.map((p) => ({ ...p, rhs: p.rhs.slice() }));
  const prodsOf = (a: string) => prods.filter((p) => p.lhs === a);
  for (let i = 0; i < order.length; i++) {
    const ai = order[i]!;
    // Make indirect recursion direct: replace A_i -> A_j γ (j < i) by A_j's alternatives.
    for (let j = 0; j < i; j++) {
      const aj = order[j]!;
      const targets = prodsOf(ai).filter((p) => p.rhs[0] === aj);
      if (!targets.length) continue;
      notes.push(`substitute ${aj} into ${ai} -> ${aj} … (indirect left recursion)`);
      prods = prods.filter((p) => !targets.includes(p));
      for (const t of targets) for (const q of prodsOf(aj)) prods.push({ id: 0, lhs: ai, rhs: [...q.rhs, ...t.rhs.slice(1)], line: t.line });
    }
    const rec = prodsOf(ai).filter((p) => p.rhs[0] === ai);
    if (!rec.length) continue;
    const nonrec = prodsOf(ai).filter((p) => p.rhs[0] !== ai);
    const tail = freshName(g, ai, used);
    notes.push(`${ai} is left-recursive: ${ai} -> β ${tail}, ${tail} -> α ${tail} | ε`);
    prods = prods.filter((p) => p.lhs !== ai);
    for (const p of nonrec) prods.push({ id: 0, lhs: ai, rhs: [...p.rhs, tail], line: p.line });
    if (!nonrec.length) prods.push({ id: 0, lhs: ai, rhs: [tail], line: 0 });
    for (const p of rec) prods.push({ id: 0, lhs: tail, rhs: [...p.rhs.slice(1), tail], line: p.line });
    prods.push({ id: 0, lhs: tail, rhs: [], line: 0 });
  }
  if (!notes.length) notes.push('no left recursion');
  return { grammar: rebuild(g, prods), notes };
}

export function leftFactor(g: Grammar): { grammar: Grammar; notes: string[] } {
  const notes: string[] = [];
  const used = new Set<string>();
  let prods: Production[] = g.productions.map((p) => ({ ...p, rhs: p.rhs.slice() }));
  for (let guard = 0; guard < 50; guard++) {
    let changed = false;
    const nts = [...new Set(prods.map((p) => p.lhs))];
    for (const a of nts) {
      const ps = prods.filter((p) => p.lhs === a);
      const groups = new Map<string, Production[]>();
      for (const p of ps) if (p.rhs.length) groups.set(p.rhs[0]!, [...(groups.get(p.rhs[0]!) ?? []), p]);
      for (const [sym, group] of groups) {
        if (group.length < 2) continue;
        // Longest common prefix of the group.
        let len = 1;
        for (;;) {
          const s = group[0]!.rhs[len];
          if (s === undefined || !group.every((p) => p.rhs[len] === s)) break;
          len++;
        }
        const prefix = group[0]!.rhs.slice(0, len);
        const tail = freshName(g, a, used);
        notes.push(`${a}: ${group.length} alternatives share the prefix "${prefix.join(' ')}" → ${a} -> ${prefix.join(' ')} ${tail}`);
        prods = prods.filter((p) => !group.includes(p));
        prods.push({ id: 0, lhs: a, rhs: [...prefix, tail], line: group[0]!.line });
        for (const p of group) prods.push({ id: 0, lhs: tail, rhs: p.rhs.slice(len), line: p.line });
        changed = true;
        void sym;
        break;
      }
      if (changed) break;
    }
    if (!changed) break;
  }
  if (!notes.length) notes.push('no common prefixes');
  return { grammar: rebuild(g, prods), notes };
}

export function augment(g: Grammar): { grammar: Grammar; notes: string[] } {
  const used = new Set<string>();
  const s2 = freshName(g, g.start, used);
  const prods: Production[] = [{ id: 0, lhs: s2, rhs: [g.start], line: 0 }, ...g.productions.map((p) => ({ ...p, rhs: p.rhs.slice() }))];
  return { grammar: rebuild(g, prods, s2), notes: [`new start symbol ${s2} -> ${g.start}`] };
}

export function toCnf(g: Grammar): { grammar: Grammar; notes: string[] } {
  const notes: string[] = [];
  let cur = clone(g);
  // 1. New start if the start symbol appears on a right side.
  if (cur.productions.some((p) => p.rhs.includes(cur.start))) {
    const a = augment(cur);
    cur = a.grammar;
    notes.push('START: ' + a.notes[0]);
  }
  // 2. ε, 3. unit, 4. useless.
  const e = removeEpsilon(cur);
  cur = e.grammar;
  notes.push('DEL: ' + e.notes.join('; '));
  const u = removeUnit(cur);
  cur = u.grammar;
  notes.push('UNIT: ' + u.notes.join('; '));
  const w = removeUseless(cur);
  cur = w.grammar;
  // 5. Terminal isolation and binarisation.
  const used = new Set<string>();
  const termVar = new Map<string, string>();
  const prods: Production[] = [];
  const fresh = (base: string): string => {
    let name = base;
    let k = 1;
    while (cur.nonterminals.includes(name) || used.has(name)) name = `${base}${k++}`;
    used.add(name);
    return name;
  };
  for (const p of cur.productions) {
    if (p.rhs.length <= 1) {
      prods.push({ ...p, rhs: p.rhs.slice() });
      continue;
    }
    const rhs = p.rhs.map((s) => {
      if (!isTerminal(cur, s)) return s;
      let v = termVar.get(s);
      if (!v) {
        v = fresh('T_' + (/^[A-Za-z0-9_]+$/.test(s) ? s : 'lit'));
        termVar.set(s, v);
        prods.push({ id: 0, lhs: v, rhs: [s], line: 0 });
        notes.push(`TERM: ${v} -> '${s}'`);
      }
      return v;
    });
    let lhs = p.lhs;
    let rest = rhs;
    while (rest.length > 2) {
      const v = fresh('X');
      prods.push({ id: 0, lhs, rhs: [rest[0]!, v], line: p.line });
      lhs = v;
      rest = rest.slice(1);
    }
    prods.push({ id: 0, lhs, rhs: rest, line: p.line });
  }
  const bin = prods.filter((p) => p.lhs.startsWith('X')).length;
  if (bin) notes.push(`BIN: ${bin} helper nonterminal(s) to make right sides binary`);
  return { grammar: rebuild(cur, prods, cur.start), notes };
}

export function isCnf(g: Grammar): boolean {
  return g.productions.every((p) => (p.rhs.length === 2 && p.rhs.every((s) => !isTerminal(g, s))) || (p.rhs.length === 1 && isTerminal(g, p.rhs[0]!)) || (p.rhs.length === 0 && p.lhs === g.start));
}
