import { describe, it, expect } from 'vitest';
import { parseRegex, thompson, subsetConstruction, minimize, nfaRun, dfaRun, fmtRegex, RegexSyntaxError } from './regex';
import { parseLexSpec, compileLexer, scan, charLex, givenTokens } from './lexer';

const PATTERNS = ['a', 'ab', 'a|b', 'a*', '(a|b)*abb', 'a+b?', '[a-c]+', '[^ab]', 'x(yz)*', '(0|1(01*0)*1)*', '\\d+(\\.\\d+)?', '[A-Za-z_][A-Za-z0-9_]*', '.', 'a?a?a?aaa', '(a|ε)'.replace('ε', '')];

function randomString(alphabet: string, n: number, rnd: () => number): string {
  let s = '';
  for (let k = 0; k < n; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
  return s;
}
function lcg(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

/** Reference: JS RegExp anchored, as ground truth for our dialect's common subset. */
function jsMatches(pattern: string, s: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(s);
}

describe('regex → NFA → DFA → minimal DFA', () => {
  for (const p of PATTERNS) {
    it(`agrees with JS RegExp on random strings: /${p}/`, () => {
      const re = parseRegex(p);
      expect(fmtRegex(re).length).toBeGreaterThan(0);
      const nfa = thompson(re);
      const dfa = subsetConstruction(nfa);
      const min = minimize(dfa).dfa;
      expect(min.states).toBeLessThanOrEqual(dfa.states);
      const rnd = lcg(7);
      for (let k = 0; k < 200; k++) {
        const s = randomString('abcxyz019._', Math.floor(rnd() * 7), rnd);
        const expected = jsMatches(p, s);
        expect(nfaRun(nfa, s).accepted, `nfa /${p}/ on "${s}"`).toBe(expected);
        expect(dfaRun(dfa, s).accepted, `dfa /${p}/ on "${s}"`).toBe(expected);
        expect(dfaRun(min, s).accepted, `min /${p}/ on "${s}"`).toBe(expected);
      }
    });
  }
  it('minimization merges equivalent states', () => {
    // Two parallel branches with the same continuation: the subset DFA keeps
    // them apart (different NFA states), minimization merges them.
    const dfa = subsetConstruction(thompson(parseRegex('a(b|c)d|a(b|c)e')));
    const { dfa: min, rounds } = minimize(dfa);
    expect(min.states).toBeLessThan(dfa.states);
    expect(rounds.length).toBeGreaterThan(1);
  });
  it('reports syntax errors with positions', () => {
    expect(() => parseRegex('(ab')).toThrow(RegexSyntaxError);
    expect(() => parseRegex('*a')).toThrow(/nothing to repeat/);
    expect(() => parseRegex('[z-a]')).toThrow(/bad range/);
  });
});

describe('scanner', () => {
  const SPEC = `skip: [ \\t\\n]+
skip: //[^\\n]*
IF: if
NUMBER: [0-9]+(\\.[0-9]+)?
ID: [A-Za-z_][A-Za-z0-9_]*
LE: <=
LT: <
ASSIGN: =
EQ: ==
`;
  it('tokenizes with maximal munch and rule priority', () => {
    const spec = parseLexSpec(SPEC);
    expect(spec.errors).toEqual([]);
    const lx = compileLexer(spec);
    const r = scan(lx, 'if iffy <= 3.14 == x // c\n<');
    expect(r.errors).toEqual([]);
    expect(r.tokens.map((t) => `${t.name}:${t.text}`)).toEqual(['IF:if', 'ID:iffy', 'LE:<=', 'NUMBER:3.14', 'EQ:==', 'ID:x', 'LT:<']);
  });
  it('backs up to the last accepting position on a dead end', () => {
    const lx = compileLexer(parseLexSpec(SPEC));
    const r = scan(lx, '3.x');
    // "3." is not a NUMBER: the scanner advanced past '.', hit a dead end on 'x', and backed up.
    expect(r.steps.some((s) => s.action === 'backtrack')).toBe(true);
    expect(r.tokens.map((t) => `${t.name}:${t.text}`)).toEqual(['NUMBER:3', 'ID:x']);
    expect(r.errors.length).toBe(1);
  });
  it('reports a lexical error and continues', () => {
    const lx = compileLexer(parseLexSpec('ID: [a-z]+\nskip: \\s+'));
    const r = scan(lx, 'ab $ cd');
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.message).toContain("'$'");
    expect(r.tokens.map((t) => t.text)).toEqual(['ab', 'cd']);
  });
  it('grammar literals become generated rules that beat identifiers', () => {
    const lx = compileLexer(parseLexSpec('ID: [a-z]+\nskip: \\s+', ['if', '(', ')']));
    const r = scan(lx, 'if (iffy)');
    expect(r.tokens.map((t) => t.name)).toEqual(['if', '(', 'ID', ')']);
  });
  it('start conditions switch the active rule set (string literals)', () => {
    const spec = parseLexSpec(`skip: \\s+
QUOTE: " => STR
<STR> STR_END: " => INITIAL
<STR> STR_TEXT: [^"]+
ID: [a-z]+`);
    expect(spec.errors).toEqual([]);
    const r = scan(compileLexer(spec), 'ab "x y" cd');
    expect(r.tokens.map((t) => t.name)).toEqual(['ID', 'QUOTE', 'STR_TEXT', 'STR_END', 'ID']);
    expect(r.steps.filter((s) => s.action === 'switch').length).toBe(2);
  });
  it('character lexer and given tokens', () => {
    expect(charLex('a b\nc').tokens.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(charLex('ab', false).tokens.length).toBe(2);
    const g = givenTokens('ID(x) PLUS NUMBER(42)');
    expect(g.tokens.map((t) => [t.name, t.text])).toEqual([['ID', 'x'], ['PLUS', 'PLUS'], ['NUMBER', '42']]);
  });
  it('spec errors have line numbers', () => {
    const spec = parseLexSpec('A: a\nnonsense line\nB: (');
    expect(spec.errors.map((e) => e.line)).toEqual([2, 3]);
  });
});
