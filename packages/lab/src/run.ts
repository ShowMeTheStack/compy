import { LexSpec, parseLexSpec, compileLexer, scan, charLex, givenTokens, LexResult, CompiledLexer, LabToken } from './lexer';
import { Grammar, parseGrammar, analyzeGrammar, checkGrammar, Analysis, Check, ParserId } from './grammar';
import { ParseResult } from './trace';
import { earleyParse } from './parsers/earley';
import { ll1Parse } from './parsers/ll1';
import { rdParse } from './parsers/rd';
import { lrParse } from './parsers/lr';
import { cykParse } from './parsers/cyk';
import { opprecParse } from './parsers/opprec';
import { cfgToPda, runPda, Pda, PdaRun } from './pda';

/**
 * One call that runs the whole lab pipeline for the current configuration,
 * returning every intermediate result for the panels.
 */
export type LexerMode = 'rules' | 'chars' | 'given';

export interface LabConfig {
  lexerMode: LexerMode;
  stage: 'lexer' | 'parser';
  parser: ParserId;
  skipWhitespace?: boolean;
}

export interface LabResult {
  spec: LexSpec | null;
  lexer: CompiledLexer | null;
  lex: LexResult;
  tokens: LabToken[];
  grammar: Grammar | null;
  analysis: Analysis | null;
  checks: Check[];
  parse: ParseResult | null;
  pda: Pda | null;
  pdaRun: PdaRun | null;
  /** Problems that stop the pipeline (grammar errors, unknown terminals…). */
  problems: { phase: 'lexer' | 'grammar' | 'parser'; message: string; line?: number }[];
}

export const PARSERS: { id: ParserId; name: string; family: string; description: string }[] = [
  { id: 'rd', name: 'Recursive descent', family: 'top-down', description: 'One procedure per nonterminal, choosing an alternative from the next token. What hand-written parsers do.' },
  { id: 'll1', name: 'LL(1) table-driven', family: 'top-down', description: 'A predict table M[A, a] from FIRST/FOLLOW and an explicit stack.' },
  { id: 'lr0', name: 'LR(0)', family: 'bottom-up', description: 'Item sets with no lookahead: reduce whenever a complete item is present.' },
  { id: 'slr1', name: 'SLR(1)', family: 'bottom-up', description: 'LR(0) items, reductions only on FOLLOW(A).' },
  { id: 'lr1', name: 'Canonical LR(1)', family: 'bottom-up', description: 'Items carry their own lookahead; the most precise, the most states.' },
  { id: 'lalr1', name: 'LALR(1)', family: 'bottom-up', description: 'LR(1) states with equal cores merged. What yacc and bison build.' },
  { id: 'earley', name: 'Earley', family: 'general', description: 'A chart parser that handles every context-free grammar, ambiguity included.' },
  { id: 'cyk', name: 'CYK', family: 'general', description: 'Dynamic programming over spans for grammars in Chomsky normal form.' },
  { id: 'opprec', name: 'Operator precedence', family: 'expressions', description: 'Precedence climbing driven by %left / %right / %nonassoc declarations.' },
];

export function runLab(cfg: LabConfig, lexText: string, grammarText: string, input: string): LabResult {
  const problems: LabResult['problems'] = [];
  let grammar: Grammar | null = null;
  let analysis: Analysis | null = null;
  let checks: Check[] = [];
  if (cfg.stage === 'parser') {
    grammar = parseGrammar(grammarText);
    for (const e of grammar.errors) problems.push({ phase: 'grammar', message: e.message, line: e.line });
    if (grammar.productions.length) {
      analysis = analyzeGrammar(grammar);
      checks = checkGrammar(grammar);
    }
  }
  // Lexing.
  let spec: LexSpec | null = null;
  let lexer: CompiledLexer | null = null;
  let lex: LexResult;
  if (cfg.lexerMode === 'chars') lex = charLex(input, cfg.skipWhitespace ?? true);
  else if (cfg.lexerMode === 'given') lex = givenTokens(input);
  else {
    spec = parseLexSpec(lexText, grammar?.literals ?? []);
    for (const e of spec.errors) problems.push({ phase: 'lexer', message: e.message, line: e.line });
    lexer = compileLexer(spec);
    lex = scan(lexer, input);
    for (const e of lex.errors) problems.push({ phase: 'lexer', message: e.message });
  }
  const tokens = lex.tokens;
  let parse: ParseResult | null = null;
  let pda: Pda | null = null;
  let pdaRun: PdaRun | null = null;
  if (cfg.stage === 'parser' && grammar && grammar.productions.length && grammar.errors.length === 0) {
    const unknown = tokens.filter((t) => !grammar!.terminals.includes(t.name));
    if (unknown.length) problems.push({ phase: 'parser', message: `token(s) not in the grammar's terminals: ${[...new Set(unknown.map((t) => t.name))].join(', ')}` });
    const blocked = checks.filter((c) => c.blocks.includes(cfg.parser));
    if (blocked.length) for (const b of blocked) problems.push({ phase: 'parser', message: `${PARSERS.find((p) => p.id === cfg.parser)?.name} cannot use this grammar: ${b.message}` });
    if (!blocked.length) {
      try {
        parse = runParser(cfg.parser, grammar, tokens);
      } catch (e) {
        problems.push({ phase: 'parser', message: e instanceof Error ? e.message : String(e) });
      }
    }
    try {
      pda = cfgToPda(grammar);
      pdaRun = tokens.length <= 40 ? runPda(pda, grammar, tokens) : null;
    } catch {
      pda = null;
    }
  }
  return { spec, lexer, lex, tokens, grammar, analysis, checks, parse, pda, pdaRun, problems };
}

export function runParser(id: ParserId, g: Grammar, tokens: LabToken[]): ParseResult {
  switch (id) {
    case 'rd': return rdParse(g, tokens);
    case 'll1': return ll1Parse(g, tokens);
    case 'lr0': case 'slr1': case 'lr1': case 'lalr1': return lrParse(g, tokens, id);
    case 'earley': return earleyParse(g, tokens);
    case 'cyk': return cykParse(g, tokens);
    case 'opprec': return opprecParse(g, tokens);
  }
}
