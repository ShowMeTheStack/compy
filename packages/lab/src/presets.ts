import type { ParserId } from './grammar';

/** A ready-made lab project: lexer mode, rules, grammar, input, parser. */
export interface LabPreset {
  name: string;
  category: string;
  description: string;
  lexerMode: 'rules' | 'chars' | 'given';
  lex: string;
  grammar: string;
  input: string;
  parser: ParserId;
  stage: 'lexer' | 'parser';
}

const ARITH_LEX = `# whitespace is skipped
skip:   [ \\t\\n]+
NUMBER: [0-9]+
ID:     [A-Za-z_][A-Za-z0-9_]*
`;

export const LAB_PRESETS: LabPreset[] = [
  {
    name: 'Arithmetic (left-recursive, for LR)',
    category: 'Grammars',
    description: 'The textbook expression grammar. Left recursion makes it natural for LR parsers and impossible for LL/recursive descent.',
    lexerMode: 'rules',
    lex: ARITH_LEX,
    grammar: `expr   -> expr '+' term | expr '-' term | term ;
term   -> term '*' factor | term '/' factor | factor ;
factor -> NUMBER | ID | '(' expr ')' ;
`,
    input: '2 + 3 * (x - 4)',
    parser: 'lalr1',
    stage: 'parser',
  },
  {
    name: 'Arithmetic (right-factored, for LL)',
    category: 'Grammars',
    description: 'The same language without left recursion: expr -> term expr\', the shape LL(1) and recursive descent need.',
    lexerMode: 'rules',
    lex: ARITH_LEX,
    grammar: `expr   -> term exprTail ;
exprTail -> '+' term exprTail | '-' term exprTail | ε ;
term   -> factor termTail ;
termTail -> '*' factor termTail | '/' factor termTail | ε ;
factor -> NUMBER | ID | '(' expr ')' ;
`,
    input: '2 + 3 * (x - 4)',
    parser: 'll1',
    stage: 'parser',
  },
  {
    name: 'Operator precedence (%left / %right)',
    category: 'Grammars',
    description: 'Precedence declarations instead of grammar layering; parsed by precedence climbing.',
    lexerMode: 'rules',
    lex: ARITH_LEX,
    grammar: `%left '+' '-'
%left '*' '/'
%right '^'

expr -> expr '+' expr | expr '-' expr | expr '*' expr | expr '/' expr | expr '^' expr | '(' expr ')' | NUMBER | ID ;
`,
    input: '1 - 2 - 3 * 4 ^ 2 ^ 1',
    parser: 'opprec',
    stage: 'parser',
  },
  {
    name: 'Balanced parentheses',
    category: 'Theory of computation',
    description: 'S -> ( S ) S | ε over single characters. The classic non-regular language.',
    lexerMode: 'chars',
    lex: '',
    grammar: `S -> '(' S ')' S | ε ;
`,
    input: '(()(()))',
    parser: 'earley',
    stage: 'parser',
  },
  {
    name: 'aⁿbⁿ',
    category: 'Theory of computation',
    description: 'S -> a S b | ε. Needs a stack: watch the PDA push an a for every a and pop one for every b.',
    lexerMode: 'chars',
    lex: '',
    grammar: `S -> a S b | ε ;
`,
    input: 'aaabbb',
    parser: 'lr1',
    stage: 'parser',
  },
  {
    name: 'Even palindromes (ambiguous for CYK)',
    category: 'Theory of computation',
    description: 'S -> a S a | b S b | ε. Inherently needs nondeterminism: LL and LR both fail, Earley and CYK succeed.',
    lexerMode: 'chars',
    lex: '',
    grammar: `S -> a S a | b S b | ε ;
`,
    input: 'abbaabba',
    parser: 'cyk',
    stage: 'parser',
  },
  {
    name: 'Dangling else (SLR conflict)',
    category: 'Conflicts',
    description: 'if-then / if-then-else: a shift/reduce conflict that every LR table has, resolved by preferring shift.',
    lexerMode: 'rules',
    lex: `skip: [ \\t\\n]+
ID:   [a-z]+
`,
    grammar: `stmt -> 'if' ID 'then' stmt | 'if' ID 'then' stmt 'else' stmt | ID ;
`,
    input: 'if a then if b then x else y',
    parser: 'slr1',
    stage: 'parser',
  },
  {
    name: 'LALR(1) is not LR(1)',
    category: 'Conflicts',
    description: 'The standard grammar whose LR(1) tables are conflict-free but whose LALR(1) merge creates a reduce/reduce conflict.',
    lexerMode: 'chars',
    lex: '',
    grammar: `S -> a E c | a F d | b F c | b E d ;
E -> e ;
F -> e ;
`,
    input: 'bed',
    parser: 'lalr1',
    stage: 'parser',
  },
  {
    name: 'Ambiguous expressions',
    category: 'Conflicts',
    description: 'E -> E + E | E * E | id with no precedence: ambiguous. Earley counts the parse trees.',
    lexerMode: 'rules',
    lex: ARITH_LEX,
    grammar: `E -> E '+' E | E '*' E | NUMBER ;
`,
    input: '1 + 2 * 3 + 4',
    parser: 'earley',
    stage: 'parser',
  },
  {
    name: 'JSON subset',
    category: 'Grammars',
    description: 'Objects, arrays, strings, numbers. Uses a start condition for string literals.',
    lexerMode: 'rules',
    lex: `skip:   [ \\t\\n]+
NUMBER: -?[0-9]+(\\.[0-9]+)?
QUOTE:  " => STR
<STR> STRING: [^"]+
<STR> QUOTE2: " => INITIAL
`,
    grammar: `value   -> object | array | STRING_LIT | NUMBER | 'true' | 'false' | 'null' ;
STRING_LIT -> QUOTE STRING QUOTE2 ;
object  -> '{' members '}' ;
members -> pair memberTail | ε ;
memberTail -> ',' pair memberTail | ε ;
pair    -> STRING_LIT ':' value ;
array   -> '[' elements ']' ;
elements -> value elementTail | ε ;
elementTail -> ',' value elementTail | ε ;
`,
    input: '{"a": [1, 2.5, true], "b": {"c": null}}',
    parser: 'll1',
    stage: 'parser',
  },
  {
    name: 'Tiny C statements',
    category: 'Grammars',
    description: 'Declarations, assignments, while and if, as LALR(1). Compare with Compy\'s real C parser.',
    lexerMode: 'rules',
    lex: `skip:   [ \\t\\n]+
skip:   //[^\\n]*
NUMBER: [0-9]+
ID:     [A-Za-z_][A-Za-z0-9_]*
`,
    grammar: `program -> stmts ;
stmts   -> stmts stmt | ε ;
stmt    -> 'int' ID ';' | ID '=' expr ';' | 'while' '(' expr ')' block | 'if' '(' expr ')' block | block ;
block   -> '{' stmts '}' ;
expr    -> expr '<' sum | sum ;
sum     -> sum '+' prod | sum '-' prod | prod ;
prod    -> prod '*' atom | atom ;
atom    -> NUMBER | ID | '(' expr ')' ;
`,
    input: `int i; i = 0;
while (i < 10) { i = i + 1; }`,
    parser: 'lalr1',
    stage: 'parser',
  },
  {
    name: 'Lexer playground',
    category: 'Lexing',
    description: 'Identifiers, numbers, operators, comments. Watch maximal munch pick <= over <, and rule order pick keywords over identifiers.',
    lexerMode: 'rules',
    lex: `skip:   [ \\t\\n]+
skip:   //[^\\n]*
IF:     if
ELSE:   else
NUMBER: [0-9]+(\\.[0-9]+)?
ID:     [A-Za-z_][A-Za-z0-9_]*
LE:     <=
LT:     <
EQ:     ==
ASSIGN: =
PLUS:   \\+
LPAREN: \\(
RPAREN: \\)
`,
    grammar: '',
    input: 'if (iffy <= 3.14) x = x + 1 // comment',
    parser: 'earley',
    stage: 'lexer',
  },
  {
    name: 'Tokens given directly',
    category: 'Lexing',
    description: 'Skip lexing: paste the token stream as names (optionally NAME(text)) and go straight to parsing.',
    lexerMode: 'given',
    lex: '',
    grammar: `expr -> expr PLUS term | term ;
term -> NUMBER | ID ;
`,
    input: 'ID(x) PLUS NUMBER(42) PLUS ID(y)',
    parser: 'lr0',
    stage: 'parser',
  },
];
