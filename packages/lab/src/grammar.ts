/**
 * Context-free grammars for the lab: a small BNF reader, the symbol tables,
 * and the classic analyses — nullable, FIRST, FOLLOW — computed as fixpoints
 * whose every iteration is kept so the Analysis panel can show the sets
 * growing. Also the structural checks (left recursion, common prefixes,
 * useless symbols) that decide which parsers a grammar can use.
 */

export interface Production {
  id: number;
  lhs: string;
  /** Right-hand side symbols; empty for ε. */
  rhs: string[];
  line: number;
}

export interface PrecDecl {
  assoc: 'left' | 'right' | 'nonassoc';
  symbols: string[];
  level: number;
  line: number;
}

export interface GrammarError {
  line: number;
  message: string;
}

export interface Grammar {
  start: string;
  productions: Production[];
  nonterminals: string[];
  terminals: string[];
  /** Terminals written as quoted literals (rendered with quotes, lexed as keywords). */
  literals: string[];
  precedence: PrecDecl[];
  errors: GrammarError[];
}

export const EPSILON = 'ε';
export const END = '$';

interface GTok {
  kind: 'id' | 'lit' | 'arrow' | 'bar' | 'semi' | 'eps' | 'prec' | 'eof';
  text: string;
  line: number;
}

function tokenizeGrammar(text: string): { toks: GTok[]; errors: GrammarError[] } {
  const toks: GTok[] = [];
  const errors: GrammarError[] = [];
  const lines = text.split('\n');
  lines.forEach((raw, k) => {
    const line = k + 1;
    let i = 0;
    const s = raw;
    while (i < s.length) {
      const c = s[i]!;
      if (c === '#') break;
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (s.startsWith('->', i) || s.startsWith('::=', i) || s.startsWith('→', i)) {
        toks.push({ kind: 'arrow', text: '->', line });
        i += s.startsWith('::=', i) ? 3 : s.startsWith('→', i) ? 1 : 2;
        continue;
      }
      if (c === ':' ) {
        toks.push({ kind: 'arrow', text: '->', line });
        i++;
        continue;
      }
      if (c === '|') {
        toks.push({ kind: 'bar', text: '|', line });
        i++;
        continue;
      }
      if (c === ';') {
        toks.push({ kind: 'semi', text: ';', line });
        i++;
        continue;
      }
      if (c === "'" || c === '"') {
        const j = s.indexOf(c, i + 1);
        if (j < 0) {
          errors.push({ line, message: 'unterminated literal' });
          break;
        }
        const lit = s.slice(i + 1, j);
        if (!lit) errors.push({ line, message: 'empty literal' });
        toks.push({ kind: 'lit', text: lit, line });
        i = j + 1;
        continue;
      }
      if (c === 'ε' || s.startsWith('epsilon', i) || s.startsWith('EPSILON', i) || (c === 'λ')) {
        toks.push({ kind: 'eps', text: 'ε', line });
        i += c === 'ε' || c === 'λ' ? 1 : 7;
        continue;
      }
      if (c === '%') {
        const m = /^%(left|right|nonassoc)\b/.exec(s.slice(i));
        if (!m) {
          errors.push({ line, message: `unknown directive at "${s.slice(i, i + 10)}"` });
          break;
        }
        toks.push({ kind: 'prec', text: m[1]!, line });
        i += m[0].length;
        continue;
      }
      const m = /^[A-Za-z_][A-Za-z0-9_']*/.exec(s.slice(i));
      if (m) {
        toks.push({ kind: 'id', text: m[0], line });
        i += m[0].length;
        continue;
      }
      // Any other single character is a bare terminal (e.g. + * ( ) in character grammars).
      toks.push({ kind: 'lit', text: c, line });
      i++;
    }
    toks.push({ kind: 'semi', text: '\n', line }); // line ends act as soft separators
  });
  toks.push({ kind: 'eof', text: '', line: lines.length });
  return { toks, errors };
}

export function parseGrammar(text: string): Grammar {
  const { toks, errors } = tokenizeGrammar(text);
  const productions: Production[] = [];
  const precedence: PrecDecl[] = [];
  const literals = new Set<string>();
  let i = 0;
  const peek = (k = 0) => toks[i + k] ?? toks[toks.length - 1]!;
  const next = () => toks[i++]!;
  const skipSeps = () => {
    while (peek().kind === 'semi') i++;
  };
  let level = 0;
  for (;;) {
    skipSeps();
    const t = peek();
    if (t.kind === 'eof') break;
    if (t.kind === 'prec') {
      next();
      const symbols: string[] = [];
      while (peek().kind === 'id' || peek().kind === 'lit') {
        const s = next();
        if (s.kind === 'lit') literals.add(s.text);
        symbols.push(s.text);
      }
      precedence.push({ assoc: t.text as PrecDecl['assoc'], symbols, level: level++, line: t.line });
      continue;
    }
    if (t.kind !== 'id' || peek(1).kind !== 'arrow') {
      errors.push({ line: t.line, message: `expected "Nonterminal -> ..." (got "${t.text}")` });
      // Skip to the next hard separator.
      while (peek().kind !== 'eof' && !(peek().kind === 'id' && peek(1).kind === 'arrow')) next();
      continue;
    }
    const lhs = next().text;
    next(); // arrow
    let rhs: string[] = [];
    let sawEps = false;
    const push = (line: number) => {
      productions.push({ id: productions.length, lhs, rhs: sawEps ? [] : rhs, line });
      rhs = [];
      sawEps = false;
    };
    let line = t.line;
    for (;;) {
      const u = peek();
      if (u.kind === 'id') {
        // A new rule starts if an identifier is followed by an arrow.
        if (peek(1).kind === 'arrow') break;
        rhs.push(next().text);
      } else if (u.kind === 'lit') {
        literals.add(next().text);
        rhs.push(u.text);
      } else if (u.kind === 'eps') {
        next();
        sawEps = true;
      } else if (u.kind === 'bar') {
        next();
        push(line);
        line = peek().line;
      } else if (u.kind === 'semi') {
        // A newline continues the rule only if the next token is a bar.
        next();
        if (u.text === ';') break;
        if (peek().kind === 'bar') continue;
        if (peek().kind === 'semi') continue;
        break;
      } else break; // eof / prec
    }
    push(line);
  }
  const nonterminals: string[] = [];
  for (const p of productions) if (!nonterminals.includes(p.lhs)) nonterminals.push(p.lhs);
  const terminals: string[] = [];
  for (const p of productions) for (const s of p.rhs) if (!nonterminals.includes(s) && !terminals.includes(s)) terminals.push(s);
  for (const d of precedence) for (const s of d.symbols) if (!terminals.includes(s) && !nonterminals.includes(s)) terminals.push(s);
  const start = nonterminals[0] ?? '';
  if (!start && errors.length === 0) errors.push({ line: 1, message: 'the grammar has no productions' });
  return { start, productions, nonterminals, terminals, literals: [...literals], precedence, errors };
}

export function isTerminal(g: Grammar, s: string): boolean {
  return !g.nonterminals.includes(s);
}

export function fmtSymbol(g: Grammar, s: string): string {
  if (s === EPSILON || s === END) return s;
  return g.literals.includes(s) || (!g.nonterminals.includes(s) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) ? `'${s}'` : s;
}
export function fmtRhs(g: Grammar, rhs: string[]): string {
  return rhs.length ? rhs.map((s) => fmtSymbol(g, s)).join(' ') : EPSILON;
}
export function fmtProduction(g: Grammar, p: Production): string {
  return `${p.lhs} -> ${fmtRhs(g, p.rhs)}`;
}
export function fmtGrammar(g: Grammar): string {
  const out: string[] = [];
  for (const d of g.precedence) out.push(`%${d.assoc} ${d.symbols.map((s) => fmtSymbol(g, s)).join(' ')}`);
  if (g.precedence.length) out.push('');
  for (const nt of g.nonterminals) {
    const alts = g.productions.filter((p) => p.lhs === nt).map((p) => fmtRhs(g, p.rhs));
    out.push(`${nt} -> ${alts.join(' | ')} ;`);
  }
  return out.join('\n');
}

// -- analyses with iteration logs ----------------------------------------------------

export interface SetLog {
  /** One row per fixpoint iteration: symbol → set contents at the end of that iteration. */
  rounds: Map<string, string[]>[];
}

export interface Analysis {
  nullable: Set<string>;
  nullableLog: string[][];
  first: Map<string, Set<string>>;
  firstLog: SetLog;
  follow: Map<string, Set<string>>;
  followLog: SetLog;
}

export function analyzeGrammar(g: Grammar): Analysis {
  // Nullable.
  const nullable = new Set<string>();
  const nullableLog: string[][] = [];
  for (;;) {
    let changed = false;
    for (const p of g.productions) {
      if (!nullable.has(p.lhs) && p.rhs.every((s) => nullable.has(s))) {
        nullable.add(p.lhs);
        changed = true;
      }
    }
    nullableLog.push([...nullable]);
    if (!changed) break;
  }
  // FIRST.
  const first = new Map<string, Set<string>>();
  for (const t of g.terminals) first.set(t, new Set([t]));
  for (const nt of g.nonterminals) first.set(nt, new Set());
  const firstLog: SetLog = { rounds: [] };
  for (;;) {
    let changed = false;
    for (const p of g.productions) {
      const target = first.get(p.lhs)!;
      for (const s of p.rhs) {
        for (const t of first.get(s) ?? []) if (!target.has(t)) {
          target.add(t);
          changed = true;
        }
        if (!nullable.has(s)) break;
      }
    }
    firstLog.rounds.push(new Map(g.nonterminals.map((nt) => [nt, [...first.get(nt)!]])));
    if (!changed) break;
  }
  // FOLLOW.
  const follow = new Map<string, Set<string>>();
  for (const nt of g.nonterminals) follow.set(nt, new Set());
  follow.get(g.start)?.add(END);
  const followLog: SetLog = { rounds: [] };
  for (;;) {
    let changed = false;
    for (const p of g.productions) {
      for (let k = 0; k < p.rhs.length; k++) {
        const s = p.rhs[k]!;
        if (isTerminal(g, s)) continue;
        const target = follow.get(s)!;
        const rest = p.rhs.slice(k + 1);
        const f = firstOfSequence(rest, first, nullable);
        for (const t of f.set) if (!target.has(t)) {
          target.add(t);
          changed = true;
        }
        if (f.nullable) for (const t of follow.get(p.lhs)!) if (!target.has(t)) {
          target.add(t);
          changed = true;
        }
      }
    }
    followLog.rounds.push(new Map(g.nonterminals.map((nt) => [nt, [...follow.get(nt)!]])));
    if (!changed) break;
  }
  return { nullable, nullableLog, first, firstLog, follow, followLog };
}

/** FIRST of a symbol sequence, and whether the whole sequence can be empty. */
export function firstOfSequence(seq: string[], first: Map<string, Set<string>>, nullable: Set<string>): { set: Set<string>; nullable: boolean } {
  const set = new Set<string>();
  for (const s of seq) {
    for (const t of first.get(s) ?? [s]) set.add(t);
    if (!nullable.has(s)) return { set, nullable: false };
  }
  return { set, nullable: true };
}

// -- structural checks ----------------------------------------------------------------

export type ParserId = 'rd' | 'll1' | 'lr0' | 'slr1' | 'lr1' | 'lalr1' | 'earley' | 'cyk' | 'opprec';

export interface Check {
  kind: 'left-recursion' | 'common-prefix' | 'unreachable' | 'unproductive' | 'undefined' | 'epsilon-cycle' | 'ok';
  message: string;
  symbols: string[];
  /** Parsers this problem blocks. */
  blocks: ParserId[];
  productions?: number[];
}

export function checkGrammar(g: Grammar): Check[] {
  const out: Check[] = [];
  // Reachability.
  const reach = new Set<string>([g.start]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of g.productions) if (reach.has(p.lhs)) for (const s of p.rhs) if (!reach.has(s)) {
      reach.add(s);
      changed = true;
    }
  }
  const unreachable = g.nonterminals.filter((nt) => !reach.has(nt));
  if (unreachable.length) out.push({ kind: 'unreachable', message: `unreachable from ${g.start}: ${unreachable.join(', ')}`, symbols: unreachable, blocks: [] });
  // Productivity.
  const productive = new Set<string>(g.terminals);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of g.productions) if (!productive.has(p.lhs) && p.rhs.every((s) => productive.has(s))) {
      productive.add(p.lhs);
      changed = true;
    }
  }
  const unproductive = g.nonterminals.filter((nt) => !productive.has(nt));
  if (unproductive.length) out.push({ kind: 'unproductive', message: `never derive a terminal string: ${unproductive.join(', ')}`, symbols: unproductive, blocks: ['rd', 'll1', 'lr0', 'slr1', 'lr1', 'lalr1', 'cyk'] });
  // Left recursion: A =>+ A α. Compute "begins-with" relation over nonterminals via nullable prefixes.
  const an = analyzeGrammar(g);
  const begins = new Map<string, Set<string>>();
  for (const nt of g.nonterminals) begins.set(nt, new Set());
  for (const p of g.productions) {
    for (const s of p.rhs) {
      if (!isTerminal(g, s)) begins.get(p.lhs)!.add(s);
      if (!an.nullable.has(s)) break;
    }
  }
  // Transitive closure.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [a, set] of begins) for (const b of [...set]) for (const c of begins.get(b) ?? []) if (!set.has(c)) {
      set.add(c);
      changed = true;
    }
  }
  const leftRec = g.nonterminals.filter((nt) => begins.get(nt)!.has(nt));
  for (const nt of leftRec) {
    const direct = g.productions.filter((p) => p.lhs === nt && p.rhs[0] === nt).map((p) => p.id);
    out.push({
      kind: 'left-recursion',
      message: direct.length ? `${nt} is directly left-recursive (${nt} -> ${nt} …): a recursive-descent/LL parser would loop forever` : `${nt} is indirectly left-recursive (${nt} ⇒+ ${nt} …)`,
      symbols: [nt],
      blocks: ['rd', 'll1'],
      productions: direct,
    });
  }
  // Common prefixes (needs left factoring for LL).
  for (const nt of g.nonterminals) {
    const ps = g.productions.filter((p) => p.lhs === nt);
    const byFirst = new Map<string, number[]>();
    for (const p of ps) {
      const k = p.rhs[0] ?? EPSILON;
      byFirst.set(k, [...(byFirst.get(k) ?? []), p.id]);
    }
    for (const [sym, ids] of byFirst) if (ids.length > 1 && sym !== EPSILON) {
      out.push({ kind: 'common-prefix', message: `${nt} has ${ids.length} alternatives starting with ${fmtSymbol(g, sym)}: left-factor them for LL(1)`, symbols: [nt], blocks: ['ll1', 'rd'], productions: ids });
    }
  }
  if (out.length === 0) out.push({ kind: 'ok', message: 'no structural problems: every nonterminal is reachable and productive, no left recursion, no common prefixes', symbols: [], blocks: [] });
  return out;
}

/** Generate random sentences from the grammar (for the random differential tests). */
export function randomSentence(g: Grammar, rnd: () => number, maxDepth = 12): string[] | null {
  const an = analyzeGrammar(g);
  const expand = (sym: string, depth: number): string[] | null => {
    if (isTerminal(g, sym)) return [sym];
    const ps = g.productions.filter((p) => p.lhs === sym);
    const pool = depth > maxDepth ? ps.filter((p) => p.rhs.every((s) => isTerminal(g, s) || an.nullable.has(s))) : ps;
    const choices = pool.length ? pool : ps;
    const p = choices[Math.floor(rnd() * choices.length)];
    if (!p) return null;
    const out: string[] = [];
    for (const s of p.rhs) {
      const part = expand(s, depth + 1);
      if (part === null) return null;
      out.push(...part);
      if (out.length > 60) return null;
    }
    return out;
  };
  return expand(g.start, 0);
}
