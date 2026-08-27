import { describe, it, expect } from 'vitest';
import { parseGrammar, analyzeGrammar, checkGrammar, randomSentence, Grammar, ParserId } from './grammar';
import { LabToken } from './lexer';
import { earleyParse } from './parsers/earley';
import { runParser, runLab } from './run';
import { buildLrTables } from './parsers/lr';
import { buildLl1Table } from './parsers/ll1';
import { transform, TRANSFORMS, TransformId } from './transform';
import { cfgToPda, runPda } from './pda';
import { buildTree, fmtTree } from './trace';
import { LAB_PRESETS } from './presets';

function toks(names: string[]): LabToken[] {
  return names.map((n, k) => ({ name: n, text: n, start: k, end: k + 1, line: 1, col: k + 1 }));
}
function lcg(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}
function randomTerminals(g: Grammar, rnd: () => number, n: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < n; k++) out.push(g.terminals[Math.floor(rnd() * g.terminals.length)]!);
  return out;
}
function treeOf(r: ReturnType<typeof earleyParse>): string {
  const { nodes, roots } = buildTree(r.treeOps);
  return roots.map((id) => fmtTree(nodes, id)).join(' ');
}

const G = {
  arithLR: `expr -> expr '+' term | term ; term -> term '*' factor | factor ; factor -> NUMBER | '(' expr ')' ;`,
  arithLL: `expr -> term exprTail ; exprTail -> '+' term exprTail | ε ; term -> factor termTail ; termTail -> '*' factor termTail | ε ; factor -> NUMBER | '(' expr ')' ;`,
  parens: `S -> '(' S ')' S | ε ;`,
  anbn: `S -> a S b | ε ;`,
  palin: `S -> a S a | b S b | ε ;`,
  dangling: `stmt -> 'if' ID 'then' stmt | 'if' ID 'then' stmt 'else' stmt | ID ;`,
  lalrNotLr1: `S -> a E c | a F d | b F c | b E d ; E -> e ; F -> e ;`,
  ambiguous: `E -> E '+' E | E '*' E | NUMBER ;`,
};

describe('FIRST / FOLLOW (Dragon book 4.4 expression grammar)', () => {
  const g = parseGrammar(G.arithLL);
  const an = analyzeGrammar(g);
  it('nullable', () => {
    expect([...an.nullable].sort()).toEqual(['exprTail', 'termTail']);
  });
  it('FIRST', () => {
    expect([...an.first.get('expr')!].sort()).toEqual(['(', 'NUMBER']);
    expect([...an.first.get('exprTail')!].sort()).toEqual(['+']);
    expect([...an.first.get('termTail')!].sort()).toEqual(['*']);
  });
  it('FOLLOW', () => {
    expect([...an.follow.get('expr')!].sort()).toEqual(['$', ')']);
    expect([...an.follow.get('exprTail')!].sort()).toEqual(['$', ')']);
    expect([...an.follow.get('term')!].sort()).toEqual(['$', ')', '+']);
    expect([...an.follow.get('factor')!].sort()).toEqual(['$', ')', '*', '+']);
  });
  it('the LL(1) table has no conflicts and the LR grammar is flagged left-recursive', () => {
    expect(buildLl1Table(g).conflicts).toEqual([]);
    const checks = checkGrammar(parseGrammar(G.arithLR));
    expect(checks.some((c) => c.kind === 'left-recursion' && c.blocks.includes('ll1'))).toBe(true);
  });
});

describe('every parser agrees with Earley on random sentences and random strings', () => {
  const cases: { name: string; grammar: string; parsers: ParserId[] }[] = [
    { name: 'arithLR', grammar: G.arithLR, parsers: ['slr1', 'lr1', 'lalr1', 'cyk'] },
    { name: 'arithLL', grammar: G.arithLL, parsers: ['rd', 'll1', 'slr1', 'lr1', 'lalr1', 'cyk'] },
    { name: 'parens', grammar: G.parens, parsers: ['rd', 'll1', 'slr1', 'lr1', 'lalr1', 'cyk'] },
    { name: 'anbn', grammar: G.anbn, parsers: ['rd', 'll1', 'slr1', 'lr1', 'lalr1', 'cyk'] },
    { name: 'palindromes', grammar: G.palin, parsers: ['cyk'] },
    { name: 'lalrNotLr1', grammar: G.lalrNotLr1, parsers: ['lr1', 'cyk'] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const g = parseGrammar(c.grammar);
      expect(g.errors).toEqual([]);
      const rnd = lcg(42);
      const inputs: string[][] = [[]];
      for (let k = 0; k < 40; k++) {
        const s = randomSentence(g, rnd, 6);
        if (s && s.length <= 14) inputs.push(s);
      }
      for (let k = 0; k < 60; k++) inputs.push(randomTerminals(g, rnd, Math.floor(rnd() * 7)));
      for (const inp of inputs) {
        const ref = earleyParse(g, toks(inp));
        for (const id of c.parsers) {
          const r = runParser(id, g, toks(inp));
          expect(r.accepted, `${id} on "${inp.join(' ')}"`).toBe(ref.accepted);
          if (ref.accepted && ref.parses === 1 && id !== 'cyk') expect(treeOf(r), `${id} tree on "${inp.join(' ')}"`).toBe(treeOf(ref));
        }
      }
    });
  }
});

describe('classic conflicts', () => {
  it('dangling else is a shift/reduce conflict in SLR(1), LALR(1) and LR(1)', () => {
    const g = parseGrammar(G.dangling);
    for (const k of ['slr1', 'lalr1', 'lr1'] as const) {
      const t = buildLrTables(g, k);
      expect(t.conflicts.some((c) => c.kind === 'shift/reduce' && c.symbol === 'else'), k).toBe(true);
    }
    // Preferring shift binds the else to the nearest if.
    const r = runParser('lalr1', g, toks(['if', 'ID', 'then', 'if', 'ID', 'then', 'ID', 'else', 'ID']));
    expect(r.accepted).toBe(true);
    expect(treeOf(r)).toBe('stmt(if ID then stmt(if ID then stmt(ID) else stmt(ID)))');
  });
  it('the LALR-vs-LR(1) grammar: LR(1) is clean, LALR(1) merging creates a reduce/reduce conflict', () => {
    const g = parseGrammar(G.lalrNotLr1);
    expect(buildLrTables(g, 'lr1').conflicts).toEqual([]);
    const lalr = buildLrTables(g, 'lalr1');
    expect(lalr.conflicts.some((c) => c.kind === 'reduce/reduce')).toBe(true);
    expect(lalr.lr1States).toBeGreaterThan(lalr.states.length);
    expect(buildLrTables(g, 'slr1').conflicts.length).toBeGreaterThan(0);
  });
  it('LR(0) cannot handle the expression grammar but SLR(1) can', () => {
    const g = parseGrammar(G.arithLR);
    expect(buildLrTables(g, 'lr0').conflicts.length).toBeGreaterThan(0);
    expect(buildLrTables(g, 'slr1').conflicts).toEqual([]);
  });
  it('Earley counts the parses of an ambiguous sentence', () => {
    const g = parseGrammar(G.ambiguous);
    const r = earleyParse(g, toks(['NUMBER', '+', 'NUMBER', '*', 'NUMBER', '+', 'NUMBER']));
    expect(r.accepted).toBe(true);
    expect(r.parses).toBe(5); // Catalan(3)
    expect(r.conflicts.some((c) => c.kind === 'choice')).toBe(true);
  });
  it('an LL(1) table conflict is reported for an ambiguous choice', () => {
    const g = parseGrammar(`S -> a S | a ;`);
    expect(buildLl1Table(g).conflicts.length).toBe(1);
  });
});

describe('error reporting', () => {
  it('each parser reports the position and expected tokens of a syntax error', () => {
    const g = parseGrammar(G.arithLL);
    for (const id of ['rd', 'll1', 'slr1', 'lr1', 'lalr1', 'earley'] as const) {
      const r = runParser(id, g, toks(['NUMBER', '+', '+', 'NUMBER']));
      expect(r.accepted, id).toBe(false);
      expect(r.error?.pos, id).toBe(2);
      expect(r.error?.expected.length, id).toBeGreaterThan(0);
      expect(r.steps[r.steps.length - 1]!.action, id).toBe('error');
    }
  });
});

describe('grammar transformations preserve the language', () => {
  const grammars: [string, string, TransformId[]][] = [
    ['arithLR', G.arithLR, ['left-recursion', 'cnf', 'useless', 'unit', 'epsilon', 'augment']],
    ['parens', G.parens, ['epsilon', 'cnf', 'left-factor']],
    ['anbn', G.anbn, ['epsilon', 'cnf']],
    ['units', `S -> A ; A -> B | 'x' A ; B -> 'y' ;`, ['unit', 'cnf']],
    ['factor', `S -> 'a' 'b' 'c' | 'a' 'b' 'd' | 'a' 'e' ;`, ['left-factor', 'cnf']],
    ['useless', `S -> 'a' S | 'b' | U ; U -> U 'c' ; V -> 'd' ;`, ['useless']],
  ];
  for (const [name, text, ids] of grammars) {
    for (const id of ids) {
      it(`${TRANSFORMS.find((t) => t.id === id)!.name} on ${name}`, () => {
        const g = parseGrammar(text);
        const r = transform(g, id);
        expect(r.grammar.errors).toEqual([]);
        expect(r.after.length).toBeGreaterThan(0);
        const rnd = lcg(3);
        const alphabet = g.terminals;
        for (let k = 0; k < 150; k++) {
          const s: string[] = [];
          const n = Math.floor(rnd() * 7);
          for (let j = 0; j < n; j++) s.push(alphabet[Math.floor(rnd() * alphabet.length)]!);
          const a = earleyParse(g, toks(s)).accepted;
          const b = earleyParse(r.grammar, toks(s)).accepted;
          expect(b, `${id} on ${name}: "${s.join(' ')}"`).toBe(a);
        }
      });
    }
  }
  it('CNF output is in Chomsky normal form and left-recursion elimination removes it', () => {
    const g = parseGrammar(G.arithLR);
    const cnf = transform(g, 'cnf').grammar;
    expect(cnf.productions.every((p) => (p.rhs.length === 2 && p.rhs.every((s) => cnf.nonterminals.includes(s))) || (p.rhs.length === 1 && !cnf.nonterminals.includes(p.rhs[0]!)))).toBe(true);
    const nolr = transform(g, 'left-recursion').grammar;
    expect(checkGrammar(nolr).some((c) => c.kind === 'left-recursion')).toBe(false);
    expect(buildLl1Table(nolr).conflicts).toEqual([]);
  });
});

describe('CFG → PDA', () => {
  for (const [name, text] of [['parens', G.parens], ['anbn', G.anbn], ['arithLL', G.arithLL], ['palin', G.palin]] as const) {
    it(`accepts exactly what Earley accepts (${name})`, () => {
      const g = parseGrammar(text);
      const pda = cfgToPda(g);
      expect(pda.transitions.length).toBe(2 + g.productions.length + g.terminals.length);
      const rnd = lcg(11);
      for (let k = 0; k < 60; k++) {
        const s = k % 2 === 0 ? randomSentence(g, rnd, 4) ?? [] : randomTerminals(g, rnd, Math.floor(rnd() * 6));
        if (s.length > 8) continue;
        const r = runPda(pda, g, toks(s));
        expect(r.accepted, `${name}: "${s.join(' ')}"`).toBe(earleyParse(g, toks(s)).accepted);
        if (r.accepted) expect(r.path[r.path.length - 1]!.state).toBe('q_accept');
      }
    });
  }
});

describe('presets run end to end', () => {
  for (const p of LAB_PRESETS) {
    it(p.name, () => {
      const r = runLab({ lexerMode: p.lexerMode, stage: p.stage, parser: p.parser }, p.lex, p.grammar, p.input);
      const fatal = r.problems.filter((x) => x.phase !== 'parser' || !x.message.includes('conflict'));
      expect(fatal, p.name).toEqual([]);
      expect(r.tokens.length).toBeGreaterThan(0);
      if (p.stage === 'parser') {
        expect(r.parse, p.name).not.toBeNull();
        expect(r.parse!.accepted, `${p.name}: ${r.parse!.error?.message}`).toBe(true);
        // The top-down PDA loops on left recursion (its frontier explodes); only
        // left-recursion-free grammars are expected to be accepted by the stepper.
        if (!r.checks.some((c) => c.kind === 'left-recursion')) expect(r.pdaRun?.accepted, p.name + ' pda').toBe(true);
      }
    });
  }
});
