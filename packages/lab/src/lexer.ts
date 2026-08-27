import { parseRegex, thompson, combineNfas, subsetConstruction, minimize, dfaStep, Nfa, Dfa, RegexNode, RegexSyntaxError } from './regex';

/**
 * The lexical layer of the lab: a flex-like rule file is compiled into one
 * scanner DFA per start condition, and the scanner runs maximal munch over
 * the input, recording every state transition so the Tokens panel can replay
 * it. Three lexer modes exist: rules, characters (every character is its own
 * token), and given (the student pastes a token list and skips lexing).
 */

export interface LexRule {
  index: number;
  name: string;
  pattern: string;
  skip: boolean;
  /** Start condition this rule is active in (default INITIAL). */
  state: string;
  /** Start condition to switch to after a match, if any. */
  nextState?: string;
  /** Generated from a quoted literal in the grammar. */
  generated?: boolean;
  line: number;
  re?: RegexNode;
}

export interface LexSpecError {
  line: number;
  message: string;
}

export interface LexSpec {
  rules: LexRule[];
  states: string[];
  errors: LexSpecError[];
}

/**
 * Rule syntax, one per line:
 *   NAME: regex                 plain rule
 *   skip: regex                 match and discard
 *   <STATE> NAME: regex         only active in start condition STATE
 *   NAME: regex => STATE        switch to STATE after matching
 *   # comment
 */
export function parseLexSpec(text: string, literals: string[] = []): LexSpec {
  const rules: LexRule[] = [];
  const errors: LexSpecError[] = [];
  const states = new Set<string>(['INITIAL']);
  // Literals from the grammar come first so keywords beat identifiers.
  for (const lit of [...literals].sort((a, b) => b.length - a.length)) {
    rules.push({ index: rules.length, name: lit, pattern: escapeLiteral(lit), skip: false, state: 'INITIAL', generated: true, line: 0 });
  }
  text.split('\n').forEach((raw, k) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(?:<([A-Za-z_][A-Za-z0-9_]*)>\s*)?([A-Za-z_][A-Za-z0-9_]*|skip)\s*:\s*(.*?)\s*(?:=>\s*([A-Za-z_][A-Za-z0-9_]*))?$/.exec(line);
    if (!m) {
      errors.push({ line: k + 1, message: `expected "NAME: regex" (got "${line.slice(0, 40)}")` });
      return;
    }
    const [, state, name, pattern, nextState] = m;
    if (!pattern) {
      errors.push({ line: k + 1, message: `rule ${name} has an empty pattern` });
      return;
    }
    if (state) states.add(state);
    if (nextState) states.add(nextState);
    rules.push({ index: rules.length, name: name!, pattern, skip: name === 'skip', state: state ?? 'INITIAL', nextState, line: k + 1 });
  });
  for (const r of rules) {
    try {
      r.re = parseRegex(r.pattern);
    } catch (e) {
      errors.push({ line: r.line, message: `rule ${r.name}: ${e instanceof RegexSyntaxError ? e.message : String(e)}` });
    }
  }
  return { rules, states: [...states], errors };
}

function escapeLiteral(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, (c) => '\\' + c);
}

// -- compiled scanner --------------------------------------------------------------

export interface CompiledState {
  state: string;
  rules: LexRule[];
  nfas: Nfa[];
  combined: Nfa;
  dfa: Dfa;
  minimal: Dfa;
  /** DFA accept state → rule (by priority). */
  acceptRule: Map<number, LexRule>;
}

export interface CompiledLexer {
  spec: LexSpec;
  states: CompiledState[];
}

export function compileLexer(spec: LexSpec): CompiledLexer {
  const states: CompiledState[] = [];
  for (const state of spec.states) {
    const rules = spec.rules.filter((r) => r.state === state && r.re);
    const nfas = rules.map((r, k) => thompson(r.re!, k));
    const combined = nfas.length ? combineNfas(nfas) : { states: 1, start: 0, accept: new Map(), edges: [] };
    const dfa = subsetConstruction(combined);
    const minimal = minimize(dfa).dfa;
    const acceptRule = new Map<number, LexRule>();
    for (const [s, id] of minimal.accept) acceptRule.set(s, rules[id]!);
    states.push({ state, rules, nfas, combined, dfa, minimal, acceptRule });
  }
  return { spec, states };
}

// -- scanning ------------------------------------------------------------------------

export interface LabToken {
  /** Terminal name as the grammar sees it. */
  name: string;
  text: string;
  start: number;
  end: number;
  rule?: LexRule;
  line: number;
  col: number;
}

export type LexAction = 'advance' | 'accept' | 'backtrack' | 'skip' | 'error' | 'switch';

export interface LexStep {
  index: number;
  action: LexAction;
  /** Input position before the action. */
  pos: number;
  state: string;
  dfaState: number | null;
  char?: string;
  nextDfaState?: number | null;
  lastAccept?: { pos: number; rule: string } | null;
  token?: LabToken;
  detail: string;
}

export interface LexResult {
  tokens: LabToken[];
  steps: LexStep[];
  errors: { pos: number; line: number; col: number; message: string }[];
}

export function scan(lexer: CompiledLexer, input: string, maxSteps = 200000): LexResult {
  const tokens: LabToken[] = [];
  const steps: LexStep[] = [];
  const errors: LexResult['errors'] = [];
  let pos = 0;
  let state = 'INITIAL';
  const lineCol = (p: number) => {
    let line = 1;
    let col = 1;
    for (let k = 0; k < p; k++) {
      if (input[k] === '\n') {
        line++;
        col = 1;
      } else col++;
    }
    return { line, col };
  };
  const step = (s: Omit<LexStep, 'index'>) => {
    if (steps.length < maxSteps) steps.push({ index: steps.length, ...s });
  };
  while (pos < input.length) {
    const cs = lexer.states.find((x) => x.state === state) ?? lexer.states[0]!;
    const dfa = cs.minimal;
    let d: number | null = dfa.start;
    let p = pos;
    let last: { pos: number; rule: LexRule } | null = null;
    if (dfa.accept.has(dfa.start)) last = { pos, rule: cs.acceptRule.get(dfa.start)! };
    while (d !== null && p < input.length) {
      const ch = input[p]!;
      const next = dfaStep(dfa, d, ch.codePointAt(0)!);
      step({ action: 'advance', pos: p, state, dfaState: d, char: ch, nextDfaState: next, lastAccept: last ? { pos: last.pos, rule: last.rule.name } : null, detail: next === null ? `no transition on '${show(ch)}' from state ${d}` : `state ${d} --'${show(ch)}'--> ${next}` });
      if (next === null) break;
      d = next;
      p++;
      const r = cs.acceptRule.get(d);
      if (r) last = { pos: p, rule: r };
    }
    if (!last || last.pos === pos) {
      const { line, col } = lineCol(pos);
      errors.push({ pos, line, col, message: `no rule matches '${show(input[pos]!)}' at ${line}:${col}` });
      step({ action: 'error', pos, state, dfaState: d, detail: `lexical error at ${line}:${col}: no rule matches '${show(input[pos]!)}'` });
      pos++;
      continue;
    }
    if (p > last.pos) step({ action: 'backtrack', pos: p, state, dfaState: d, lastAccept: { pos: last.pos, rule: last.rule.name }, detail: `dead end at ${p}; back up to the last accepting position ${last.pos} (${last.rule.name})` });
    const text = input.slice(pos, last.pos);
    const { line, col } = lineCol(pos);
    const tok: LabToken = { name: last.rule.name, text, start: pos, end: last.pos, rule: last.rule, line, col };
    if (last.rule.skip) step({ action: 'skip', pos, state, dfaState: d, token: tok, detail: `skip "${show(text)}"` });
    else {
      tokens.push(tok);
      step({ action: 'accept', pos, state, dfaState: d, token: tok, detail: `emit ${last.rule.name} "${show(text)}"` });
    }
    pos = last.pos;
    if (last.rule.nextState && last.rule.nextState !== state) {
      step({ action: 'switch', pos, state, dfaState: null, detail: `start condition ${state} → ${last.rule.nextState}` });
      state = last.rule.nextState;
    }
  }
  return { tokens, steps, errors };
}

function show(s: string): string {
  return s.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

// -- the other lexer modes ---------------------------------------------------------------

/** Every character is a token named by itself; whitespace optionally skipped. */
export function charLex(input: string, skipWhitespace = true): LexResult {
  const tokens: LabToken[] = [];
  const steps: LexStep[] = [];
  let line = 1;
  let col = 1;
  for (let k = 0; k < input.length; k++) {
    const ch = input[k]!;
    const ws = /\s/.test(ch);
    const tok: LabToken = { name: ch, text: ch, start: k, end: k + 1, line, col };
    if (ws && skipWhitespace) steps.push({ index: steps.length, action: 'skip', pos: k, state: 'chars', dfaState: null, token: tok, detail: `skip whitespace` });
    else {
      tokens.push(tok);
      steps.push({ index: steps.length, action: 'accept', pos: k, state: 'chars', dfaState: null, token: tok, detail: `emit '${show(ch)}'` });
    }
    if (ch === '\n') {
      line++;
      col = 1;
    } else col++;
  }
  return { tokens, steps, errors: [] };
}

/** The student supplies tokens directly: whitespace-separated names, optionally NAME(text). */
export function givenTokens(input: string): LexResult {
  const tokens: LabToken[] = [];
  const re = /(\S+?)(?:\(([^)]*)\))?(?=\s|$)/g;
  let m: RegExpExecArray | null;
  let line = 1;
  while ((m = re.exec(input))) {
    const before = input.slice(0, m.index);
    line = before.split('\n').length;
    const col = m.index - before.lastIndexOf('\n');
    tokens.push({ name: m[1]!, text: m[2] ?? m[1]!, start: m.index, end: m.index + m[0].length, line, col });
  }
  return { tokens, steps: tokens.map((t, k) => ({ index: k, action: 'accept' as const, pos: t.start, state: 'given', dfaState: null, token: t, detail: `given ${t.name}` })), errors: [] };
}
