/**
 * The automata-theory and parsing course that lives in the Language lab's
 * Learn tab. Each lesson loads one preset and opens the panel where the
 * construction it talks about is drawn.
 */
export interface LabLesson {
  id: string;
  title: string;
  section: 'automata' | 'grammars';
  summary: string;
  body: string[];
  preset: string;
  panel: 'automata' | 'tokens' | 'analysis' | 'parse' | 'tree';
  tryThis: string[];
}

export const LAB_LESSONS: LabLesson[] = [
  {
    id: 'regex-and-tokens',
    title: 'Regular expressions and tokens',
    section: 'automata',
    summary: 'Each token kind is a regular language; a rule file is a list of regexes with priorities.',
    body: [
      'A lexical rule such as `ID: [A-Za-z_][A-Za-z0-9_]*` names a **regular language**: the set of strings the regex matches. The rule file in `tokens.lex` is just a list of these, one per token kind, plus `skip:` rules for whitespace and comments. The three operations that build regular expressions are **concatenation**, **alternation** (`|`) and **Kleene star** (`*`); `+`, `?`, character classes and `.` are abbreviations for combinations of those three.',
      'Two conventions settle which rule produces a token when several could. **Maximal munch**: the longest match wins, so `<=` is one token even though `<` also matches. **Priority**: among equal-length matches, the earlier rule wins, so a keyword rule listed before `ID` beats the identifier rule on the string `if`.',
      'Everything in this section is about turning that rule file into a machine that decides membership in constant time per character: a deterministic finite automaton.',
    ],
    preset: 'Lexer playground',
    panel: 'tokens',
    tryThis: ['In the Tokens panel step through the scan and watch `<=` win over `<`.', 'Move the `ID` rule above `IF` in tokens.lex: `if` now lexes as an identifier.', 'Add a rule `FLOAT: [0-9]+\\.[0-9]+` after `NUMBER` and see which one `3.14` matches, then swap their order.'],
  },
  {
    id: 'thompson',
    title: "Thompson's construction: regex → NFA",
    section: 'automata',
    summary: 'Every regex becomes a nondeterministic automaton with ε-edges by gluing small fragments together.',
    body: [
      'Thompson’s construction is inductive on the regex. A single character `a` becomes two states joined by an `a` edge. For `R|S` add a new start with ε-edges into both fragments and a new accept both fragments flow into. For `RS` connect the accept of R to the start of S by an ε-edge. For `R*` add a new start and accept, with ε-edges that let you skip R or loop back into it.',
      'The result is an **NFA**: a state may have several edges on the same symbol, and ε-edges move without consuming input. Its size is linear in the regex, which is why it is the construction every lexer generator starts from. The price is that running it directly means tracking a *set* of possible states.',
      'The drawing numbers the states in creation order, so you can see each fragment and the ε-glue between them.',
    ],
    preset: 'Lexer playground',
    panel: 'automata',
    tryThis: ['Pick the `NUMBER` rule and read the NFA for `[0-9]+(\\.[0-9]+)?`: find the loop for `+` and the skip edge for `?`.', 'Type `(a|b)*abb` in the regex box and count the ε-edges.', 'Switch to “run a string” with the NFA selected and watch the active-state set as you step through `aabb`.'],
  },
  {
    id: 'subset-construction',
    title: 'Subset construction: NFA → DFA',
    section: 'automata',
    summary: 'A DFA state is a set of NFA states; following an input from a set gives another set.',
    body: [
      'Running an NFA means asking “which states could I be in?”. The subset construction makes that question the state itself: the DFA’s start state is the **ε-closure** of the NFA start, and from a set S on input a you go to the ε-closure of every NFA state reachable from S on a. A set you have not seen before is a new DFA state; a set containing any NFA accepting state is accepting.',
      'The table in the panel is exactly this computation: one row per discovered set, one column per input range. The alphabet is first split into disjoint ranges so that `[a-z]` and `[a-c]` become `a-c` and `d-z`, which keeps the table small.',
      'The DFA can be exponentially larger than the NFA in the worst case (`(a|b)*a(a|b)^n` is the classic example), but for the regexes in real rule files it is small, and it runs in one table lookup per character.',
    ],
    preset: 'Lexer playground',
    panel: 'automata',
    tryThis: ['Open “subset construction” for the `ID` rule and follow the start set through `a` then `1`.', 'Try the regex `(a|b)*a(a|b)(a|b)` and compare NFA and DFA sizes.', 'Run the same string on the NFA and the DFA: the NFA’s active set at each step is the DFA state’s subset.'],
  },
  {
    id: 'minimization',
    title: 'DFA minimization',
    section: 'automata',
    summary: 'States that cannot be told apart by any future input are merged; the result is unique.',
    body: [
      'Two DFA states are **equivalent** if every string leads from both to the same accept/reject outcome. Hopcroft’s algorithm (shown here as the simpler partition-refinement form) starts with the coarsest partition, accepting versus non-accepting, and repeatedly splits any group whose members disagree on where some input leads, until nothing splits. Each remaining group is one state of the minimal DFA.',
      'The minimal DFA is unique up to renaming, which is the **Myhill–Nerode** theorem in action: the number of states equals the number of equivalence classes of the language’s right-invariant relation. Minimization is how a lexer generator gets a compact table, and how you can prove two regexes describe the same language: minimize both and compare.',
    ],
    preset: 'Lexer playground',
    panel: 'automata',
    tryThis: ['Type `a(b|c)d|a(b|c)e` in the regex box: the subset DFA has two states for “after b” and “after c”; minimization merges them. Read the rounds.', 'Try `(a|ε)(a|ε)a`-style patterns written as `a?a?a` and see the partitions.'],
  },
  {
    id: 'maximal-munch',
    title: 'Maximal munch and backing up',
    section: 'automata',
    summary: 'The scanner runs the DFA as far as it can, remembers the last accepting position, and backs up to it.',
    body: [
      'A scanner is a DFA plus a loop. Starting at the current position it follows transitions while they exist, noting every time it passes through an accepting state. When it gets stuck it does not fail: it emits the token for the **last** accepting position and resumes scanning from there. The characters read beyond that point are re-scanned.',
      'The scanner DFA for a whole rule file is built by combining all rule NFAs under one new start state; an accepting state records which rule it belongs to, lowest rule number first, which implements priority. The Tokens panel animates this: watch the tape cursor run ahead and snap back.',
      'Pathological rule sets can make this quadratic (a rule that accepts a long prefix but only rarely completes), which is why lexer generators warn about rules that need unbounded backup.',
    ],
    preset: 'Lexer playground',
    panel: 'tokens',
    tryThis: ['Set input.txt to `3.x` and step: the scanner reads `3.`, dies on `x`, and backs up to emit `NUMBER(3)`.', 'Set the input to `iffy` and confirm the identifier rule wins by length over the `if` keyword.', 'Remove the `skip:` rule for whitespace and watch the lexical errors appear.'],
  },
  {
    id: 'start-conditions',
    title: 'Start conditions (lexer states)',
    section: 'automata',
    summary: 'Different rule sets for different contexts, such as inside a string literal.',
    body: [
      'Some tokens are easier to describe with a mode switch than with one regex: inside a string literal the rules for identifiers and operators should not apply. A rule can be restricted to a **start condition** with `<STATE>` and can switch the scanner into another condition with `=> STATE` after it matches. Each condition compiles to its own scanner DFA.',
      'This is exactly flex’s `%x` exclusive start states, and it is still regular: the set of conditions is finite, so the whole lexer is one big DFA whose states are (condition, DFA state) pairs.',
    ],
    preset: 'JSON subset',
    panel: 'tokens',
    tryThis: ['Step through `"a"` in the JSON preset: `QUOTE` switches to STR, `STRING` matches, `QUOTE2` switches back.', 'In the Automata panel switch the condition selector between INITIAL and STR to see the two scanner DFAs.'],
  },
  {
    id: 'cfg-and-derivations',
    title: 'Context-free grammars and derivations',
    section: 'grammars',
    summary: 'Productions rewrite nonterminals; a derivation is a sequence of rewrites from the start symbol to the input.',
    body: [
      'A context-free grammar has terminals (the tokens), nonterminals, productions `A -> α`, and a start symbol. A string is in the language if some sequence of rewrites turns the start symbol into it. A **leftmost derivation** always rewrites the leftmost nonterminal; a **rightmost derivation** the rightmost. Top-down parsers produce the former as they go, bottom-up parsers produce the latter in reverse.',
      'Balanced parentheses, `aⁿbⁿ`, and nested expressions are context-free but not regular: a finite automaton cannot count. That is the step up from the previous section, and it is why a parser needs a stack.',
      'Write grammars as `A -> α | β ;` in grammar.cfg. Quoted literals become keyword tokens automatically; any other symbol with no production is a terminal that your lexer must produce.',
    ],
    preset: 'Balanced parentheses',
    panel: 'tree',
    tryThis: ['Load the preset and look at the tree for `(()(()))`; find each `S -> ε` leaf.', 'Change the input to `(()` and read the error: where did the parser give up, and what did it expect?', 'Write `S -> a S b | ε` with the character lexer and try `aabb` and `aab`.'],
  },
  {
    id: 'ambiguity',
    title: 'Parse trees, ambiguity and the dangling else',
    section: 'grammars',
    summary: 'A grammar is ambiguous if some string has two parse trees; Earley counts them for you.',
    body: [
      'The parse tree records *which* productions were used; the derivation order is irrelevant. If a string has two different trees the grammar is **ambiguous**, which is a property of the grammar, not the language. `E -> E + E | E * E | NUMBER` is the standard example: `1 + 2 * 3` has two trees, and only one of them matches the arithmetic you expect.',
      'Ambiguity is undecidable in general, so no tool can tell you a grammar is unambiguous. What tools do is report **conflicts** in a particular parser’s tables, which are a sufficient (not necessary) sign. The Earley parser here goes further for a given input: it counts the distinct parse trees.',
      'The dangling else is the famous ambiguity in real languages: `if a then if b then x else y` — which `if` owns the `else`? Every LR table for this grammar has a shift/reduce conflict on `else`, and the conventional fix is to prefer shift, binding the `else` to the nearest `if`.',
    ],
    preset: 'Ambiguous expressions',
    panel: 'parse',
    tryThis: ['Run the ambiguous preset with Earley and read the parse count for `1 + 2 * 3 + 4` (five trees).', 'Load “Dangling else”, open the Parse panel with SLR(1), and find the conflict in the ACTION table; then step and watch shift win.', 'Add `%left \'+\'` and `%left \'*\'` lines and switch to the operator-precedence parser to see one tree.'],
  },
  {
    id: 'first-follow',
    title: 'Nullable, FIRST and FOLLOW',
    section: 'grammars',
    summary: 'The three sets every predictive parser is built from, computed as fixpoints.',
    body: [
      '**Nullable(A)** says whether A can derive the empty string. **FIRST(A)** is the set of terminals that can begin a string derived from A. **FOLLOW(A)** is the set of terminals that can appear immediately after A in some sentential form, with `$` for the end of input. All three are computed by starting from empty sets and applying each production until nothing changes.',
      'FIRST of a sequence `X₁ X₂ … Xₙ` includes FIRST(X₁), plus FIRST(X₂) if X₁ is nullable, and so on. FOLLOW(B) for a production `A -> α B β` includes FIRST(β), and FOLLOW(A) if β is nullable. The Analysis panel replays the iterations so you can see sets grow and watch the dependency between FOLLOW sets resolve.',
    ],
    preset: 'Arithmetic (right-factored, for LL)',
    panel: 'analysis',
    tryThis: ['Step the FIRST iterations: `expr` gets `(` and `NUMBER` only after `factor` and `term` do.', 'Step FOLLOW and watch `)` and `$` flow from `expr` into `exprTail`, `term`, and `factor`.', 'Add a production `factor -> ε` and see which sets change.'],
  },
  {
    id: 'll1',
    title: 'LL(1) tables and predictive parsing',
    section: 'grammars',
    summary: 'One lookahead token picks the production; a stack replaces recursion.',
    body: [
      'An LL(1) parser reads the input Left to right, builds a Leftmost derivation, and looks 1 token ahead. The table entry M[A, a] holds the production `A -> α` to use when A is on the stack and a is the next token: every production goes into the cells for FIRST(α), and into FOLLOW(A) as well if α is nullable. A grammar is LL(1) exactly when no cell gets two productions.',
      'The driver is a stack initialised with `$` and the start symbol. If the top is a terminal it must match the input; if it is a nonterminal, consult the table and replace it with the chosen right-hand side (reversed, so the first symbol ends up on top). The Parse panel highlights the cell consulted at each step and grows the tree top-down, exactly in leftmost-derivation order.',
    ],
    preset: 'Arithmetic (right-factored, for LL)',
    panel: 'parse',
    tryThis: ['Step the parse and watch the highlighted table cell at each expansion.', 'Load the left-recursive arithmetic preset and pick LL(1): the Analysis panel explains why it is blocked, and offers the fix.', 'Introduce a common prefix, e.g. `factor -> ID | ID \'(\' \')\'`, and find the conflict cell.'],
  },
  {
    id: 'recursive-descent',
    title: 'Recursive descent from a grammar',
    section: 'grammars',
    summary: 'The LL(1) table as code: one procedure per nonterminal, the call stack as the parse stack.',
    body: [
      'A recursive-descent parser is the LL(1) idea written as ordinary code: each nonterminal becomes a procedure whose body is an `if` chain on the lookahead, one branch per alternative, calling other procedures for nonterminals and `expect()` for terminals. The runtime call stack plays the role of the explicit stack in the table-driven parser.',
      'This is how Compy’s own C parser is written, and how most hand-written parsers in production compilers work, because it is easy to add good error messages and semantic actions. Its limits are the same as LL(1)’s: no left recursion (the procedure would call itself before consuming anything) and no common prefixes without left factoring.',
      'The Parse panel shows the generated pseudocode with the executing line highlighted and the live call stack.',
    ],
    preset: 'Arithmetic (right-factored, for LL)',
    panel: 'parse',
    tryThis: ['Select “Recursive descent” and step: match each highlighted pseudocode line to the token consumed.', 'Watch the call stack depth for `((1))` versus `1 + 1 + 1`.', 'Load the left-recursive preset, apply “Eliminate left recursion” in Analysis, and come back: the parser now works.'],
  },
  {
    id: 'left-recursion-factoring',
    title: 'Left recursion and left factoring',
    section: 'grammars',
    summary: 'Two mechanical rewrites that make a grammar LL(1)-friendly without changing its language.',
    body: [
      '`A -> A α | β` loops a top-down parser forever. The rewrite `A -> β A\'`, `A\' -> α A\' | ε` generates the same strings (a β followed by any number of α) with the recursion on the right. Indirect left recursion (`A -> B x`, `B -> A y`) is first turned into direct recursion by substituting nonterminals in a fixed order; that is Paull’s algorithm, which the Analysis panel applies.',
      'Left factoring handles `A -> α β | α γ`, where one token of lookahead cannot choose: `A -> α A\'`, `A\' -> β | γ` defers the choice until after α. Both transformations change the shape of the parse tree (the operator becomes right-nested), which is why LR parsers, which need neither, are popular for expression grammars.',
      'Every transformation here shows a diff and is checked by the test suite to preserve the language on random strings.',
    ],
    preset: 'Arithmetic (left-recursive, for LR)',
    panel: 'analysis',
    tryThis: ['Open “transformations”, pick “Eliminate left recursion”, read the diff, apply it, then parse with LL(1).', 'Compare the two parse trees for `1 - 2 - 3` before and after: which one matches left-associative subtraction?', 'Write a grammar with indirect left recursion and watch the substitution notes.'],
  },
  {
    id: 'lr0-items',
    title: 'LR(0) items and the goto graph',
    section: 'grammars',
    summary: 'A bottom-up parser’s states are sets of dotted productions; the goto graph is a DFA over grammar symbols.',
    body: [
      'An **item** `A -> α • β` means “we have seen α and may be in the middle of an A”. A state is a set of items closed under: if the dot is before a nonterminal B, add `B -> • γ` for every B production. **Goto(I, X)** moves the dot over X in every item of I and closes again. Starting from the closure of `S\' -> • S`, this builds a DFA whose alphabet is the grammar’s symbols: the goto graph.',
      'The parser keeps a stack of states. On a terminal it **shifts** (follows the goto edge); when a state contains a complete item `A -> α •` it **reduces**: pop |α| states, and follow the goto edge on A from the state now on top. The tree is built bottom-up as reductions happen, which is a rightmost derivation in reverse.',
      'LR(0) reduces whenever a complete item is present, without looking at the input. That is too eager for most grammars: the expression grammar already has a conflict.',
    ],
    preset: 'aⁿbⁿ',
    panel: 'parse',
    tryThis: ['Pick LR(0) and step through `aaabbb`: shifts walk the goto graph, reductions jump back.', 'Open “item sets” and find the kernel items (bold) versus closure items.', 'Load the left-recursive arithmetic preset with LR(0) and find the shift/reduce conflict.'],
  },
  {
    id: 'slr-lr1-lalr',
    title: 'SLR(1), LR(1), LALR(1): what lookahead buys',
    section: 'grammars',
    summary: 'Three ways to decide when to reduce, trading table size for precision.',
    body: [
      '**SLR(1)** keeps LR(0) states but reduces by `A -> α` only on tokens in FOLLOW(A). Cheap, and enough for many grammars, but FOLLOW is a global approximation: it includes tokens that can follow A somewhere, not necessarily here.',
      '**Canonical LR(1)** carries a lookahead in each item, `A -> α • β, a`, computed precisely for the context the item was created in. It resolves everything SLR can plus more, at the cost of many more states, since the same core appears with different lookaheads.',
      '**LALR(1)** merges LR(1) states that have the same core and unions their lookaheads. It has as many states as SLR with almost the precision of LR(1); yacc and bison build it. Merging can introduce reduce/reduce conflicts that LR(1) does not have — the preset “LALR(1) is not LR(1)” is the standard four-production example.',
    ],
    preset: 'LALR(1) is not LR(1)',
    panel: 'parse',
    tryThis: ['Pick Canonical LR(1): no conflicts, note the state count. Pick LALR(1): fewer states, and a reduce/reduce conflict appears; find the merged state.', 'Pick SLR(1) on “Dangling else” and locate the shift/reduce conflict on `else`.', 'Load the left-recursive arithmetic preset: LR(0) conflicts, SLR(1) is clean.'],
  },
  {
    id: 'conflicts',
    title: 'Shift/reduce conflicts and how yacc resolves them',
    section: 'grammars',
    summary: 'When a table cell holds two actions, something has to choose; the defaults are shift, and the earlier rule.',
    body: [
      'A **shift/reduce** conflict means the parser could either keep reading or finish a production now. A **reduce/reduce** conflict means two productions both match what is on the stack. Both show up as cells with two entries in the ACTION table, highlighted red. The driver here resolves them the way yacc does by default: shift wins over reduce, and among reductions the earlier production wins, and it tells you so in the step detail.',
      'Real generators let you declare `%left`, `%right` and `%nonassoc` precedence to resolve expression-grammar conflicts deliberately rather than by accident. Compy’s operator-precedence parser uses those same declarations directly.',
    ],
    preset: 'Dangling else (SLR conflict)',
    panel: 'parse',
    tryThis: ['Open “ACTION / GOTO” and find the red cell. Step to it and read how the conflict was resolved.', 'Rewrite the grammar with separate `matched` and `unmatched` statement nonterminals (the textbook fix) and watch the conflict disappear.'],
  },
  {
    id: 'earley',
    title: 'Earley parsing: any grammar at all',
    section: 'grammars',
    summary: 'A chart parser that handles left recursion, ambiguity and ε without any grammar restrictions.',
    body: [
      'Earley’s algorithm keeps a chart with one column per input position; column k holds items `A -> α • β, j` meaning “an A started at j and α covers tokens j..k”. Three operations fill it: **predict** (dot before a nonterminal: add its productions starting here), **scan** (dot before the next input token: copy the item to the next column with the dot advanced), and **complete** (a finished item: advance every item in its origin column that was waiting for it).',
      'It runs in cubic time in the worst case, quadratic for unambiguous grammars, and linear for most LR grammars, and it accepts the input exactly when the start item is complete in the last column with origin 0. Because every derivation is recorded through back-pointers, the number of parse trees can be counted, which is how this lab detects ambiguity on a given input.',
      'Earley is the reference parser here: every other parser is tested against it on random strings.',
    ],
    preset: 'Ambiguous expressions',
    panel: 'parse',
    tryThis: ['Step through the chart and watch items appear column by column, coloured by the operation that added them.', 'Load “Even palindromes”: LL and LR all fail, Earley and CYK succeed. Why does a palindrome need nondeterminism?', 'Give Earley a left-recursive grammar; no transformation was needed.'],
  },
  {
    id: 'cyk',
    title: 'CYK and Chomsky normal form',
    section: 'grammars',
    summary: 'Dynamic programming over spans, for grammars whose productions are all A -> B C or A -> a.',
    body: [
      'The CYK algorithm fills a triangular table: cell (i, len) holds the nonterminals that derive the tokens starting at i of length len. Length-1 cells come from `A -> a` rules; longer cells combine two sub-spans through `A -> B C`. The input is accepted if the start symbol reaches the top cell. The restriction to binary productions is what makes the split point the only choice.',
      '**Chomsky normal form** is reachable from any grammar: add a fresh start, remove ε-productions, remove unit productions, replace terminals inside long productions by new nonterminals, and binarise. The lab performs these steps automatically when you choose CYK and shows the converted grammar; the Analysis panel lets you apply each step by hand with a diff.',
    ],
    preset: 'Even palindromes (ambiguous for CYK)',
    panel: 'parse',
    tryThis: ['Step the triangle filling bottom-up for `abbaabba` and find the split used at the top.', 'Open Analysis → transformations → “Convert to Chomsky normal form” on the arithmetic grammar and read the notes.', 'Try `abba` versus `abab`: which top cell is empty?'],
  },
  {
    id: 'operator-precedence',
    title: 'Operator precedence parsing',
    section: 'grammars',
    summary: 'Precedence and associativity declarations instead of grammar layering; the algorithm Compy’s C parser uses for expressions.',
    body: [
      'Instead of one nonterminal per precedence level (`expr`, `term`, `factor`…), declare the operators: `%left \'+\' \'-\'` then `%left \'*\' \'/\'`, later lines binding tighter, `%right` for right-associative ones. **Precedence climbing** parses an operand, then loops: while the next operator binds at least as tightly as the current minimum, consume it and parse its right operand with a higher minimum (equal for right-associative operators).',
      'The Parse panel shows both views of the same algorithm: the recursive calls with their minimum precedence, and the operand/operator stacks of the equivalent shunting-yard machine. This is exactly how the C expression parser in Compy’s compiler mode decides that `a + b * c` groups as `a + (b * c)`.',
    ],
    preset: 'Operator precedence (%left / %right)',
    panel: 'parse',
    tryThis: ['Step `1 - 2 - 3`: left associativity makes the second `-` wait until the first is combined.', 'Change `%right \'^\'` to `%left` and see the tree for `2 ^ 3 ^ 2` flip.', 'Make `\'<\'` `%nonassoc` and parse `a < b < c`: it is rejected.'],
  },
  {
    id: 'cfg-to-pda',
    title: 'From grammar to pushdown automaton',
    section: 'grammars',
    summary: 'Every CFG has an equivalent PDA; the construction is a nondeterministic top-down parser.',
    body: [
      'A pushdown automaton is a finite automaton with a stack. The standard construction from a grammar uses three states: push `$` and the start symbol, then loop: if a nonterminal is on top, replace it (nondeterministically) by one of its right-hand sides; if a terminal is on top, match it against the next input symbol and pop. Reaching `$` with the input consumed accepts. It recognises exactly the grammar’s language, which is half of the proof that CFGs and PDAs are equivalent.',
      'Because the expansion step guesses, the simulation here tracks the whole set of possible configurations (state, remaining input, stack), like running an NFA. On a left-recursive grammar the guesses can expand forever without reading input: the frontier explodes, which is the PDA-level view of why top-down parsers need left recursion removed. The LR parsers are the deterministic bottom-up PDA that does not have this problem.',
    ],
    preset: 'aⁿbⁿ',
    panel: 'analysis',
    tryThis: ['Open “pushdown automaton” and step the configurations for `aaabbb`: the stack grows with `S b b b` then shrinks.', 'Try `aabbb` and watch every configuration die.', 'Load the left-recursive arithmetic grammar and see the frontier get cut off; apply left-recursion elimination and try again.'],
  },
];
