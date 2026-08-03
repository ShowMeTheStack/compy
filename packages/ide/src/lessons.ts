/**
 * Teaching content for the compiler course: one lesson per topic, grouped by
 * compiler phase. Each lesson ships a runnable C89 program whose behaviour in
 * the tool makes the topic visible in the matching panel (Tokens, AST, Types,
 * IR, Optimize, Assembly, Memory). The body renderer supports **bold** and
 * `code` spans only — no headers, lists or links.
 */
export type Phase =
  "lex" | "preprocess" | "parse" | "sema" | "ir" | "opt" | "codegen" | "run";

export interface Lesson {
  /** kebab-case, unique */
  id: string;
  title: string;
  phase: Phase;
  /** one sentence */
  summary: string;
  /** 3–6 paragraphs of plain prose; **bold** and `code` spans only */
  body: string[];
  /** a complete, deterministic, runnable C89 program (< 40 lines) */
  example: string;
  /** concrete things to do in the tool */
  tryThis: string[];
}

export const PHASE_TITLES: Record<Phase, string> = {
  lex: "Lexing",
  preprocess: "Preprocessing",
  parse: "Parsing",
  sema: "Semantic analysis",
  ir: "Intermediate representation",
  opt: "Optimization",
  codegen: "Code generation",
  run: "Execution",
};

export const LESSONS: Lesson[] = [
  // ───────────────────────────── lex ─────────────────────────────
  {
    id: "what-a-lexer-does",
    title: "What a lexer does",
    phase: "lex",
    summary:
      "The lexer turns a stream of characters into a stream of tokens, the smallest meaningful units of the language.",
    body: [
      'A compiler never looks at your program one character at a time for long. The very first thing it does is group characters into **tokens**: a keyword like `int`, an identifier like `count`, a constant like `0x10` or `1.5e1`, a string literal like `"tokens"`, or a punctuator like `+=` or `(`. Everything else, whitespace and comments, is thrown away. This phase is called lexing, scanning or tokenizing, and the component that does it is the **lexer**.',
      "Each token carries three things: its **kind** (keyword, identifier, constant, string, punctuator), its **spelling** (the exact characters it came from), and its **location** (file, line and column). The location is what every later error message points at, which is why a lexer that mis-counts columns makes a whole compiler feel broken.",
      "The lexer has no idea what the program means. It does not know that `count` is a variable, that `ratio` is a double, or that the parentheses are balanced. It only knows the shape of each piece. That separation is deliberate: the lexer handles the messy character-level details (escapes, number formats, comments) so that the parser can think in terms of clean tokens.",
      "In the example every line exercises a different token kind. Hex, octal and decimal constants all become integer-constant tokens whose value the lexer has already computed; `1.5e1` becomes a floating constant; `'A'` a character constant; the string literal keeps its quotes stripped and escapes decoded. The operators `+=`, `>=`, `&&` and `!=` are each one token even though they are two characters long.",
    ],
    example: `#include <stdio.h>

/* Every character below becomes one of: keyword, identifier,
   constant, string literal, or punctuator. Whitespace and this
   comment produce no tokens at all. */
int main(void) {
    int count = 0x10 + 010 + 10;   /* hex, octal, decimal: 16 + 8 + 10 */
    double ratio = 1.5e1;          /* a floating constant: 15.0 */
    char letter = 'A';             /* a character constant */
    const char *msg = "tokens";    /* a string literal */
    count += (int)ratio;
    printf("%d %c %s %d\\n", count, letter, msg, count >= 41 && letter != 'B');
    return 0;
}
`,
    tryThis: [
      "Open the Tokens panel and count how many tokens the line `int count = 0x10 + 010 + 10;` produces (it should be 10).",
      "Hover the `0x10` and `010` tokens: the lexer has already converted both to their values, 16 and 8.",
      "Change `+=` to `+ =` and run again. The lexer now produces two tokens and the parser rejects the program.",
    ],
  },
  {
    id: "translation-phases",
    title: "Translation phases 1–3 (line splicing, comments)",
    phase: "lex",
    summary:
      "Before tokens exist, the C standard mandates three character-level passes: character mapping, line splicing and comment removal.",
    body: [
      "The C standard describes compilation as eight **translation phases**, and the first three happen before any token is recognised. Phase 1 maps the source character set and replaces trigraphs. Phase 2 deletes every backslash that is immediately followed by a newline, joining the two physical lines into one **logical line**. Phase 3 breaks the result into preprocessing tokens and replaces every comment with a single space.",
      "Line splicing is why a `#define` can span several lines: the backslash at the end of each line tells phase 2 to glue the next line on. It works anywhere, not just in macros, which is why the `int z = 1 + \\` line in the example is legal (if ugly). The splice happens so early that even a comment or a string literal can be continued across lines this way.",
      "Comment removal explains a classic surprise: `4/* comment */+ 2` is not an error. The comment becomes one space, so the lexer sees `4 + 2`. The reverse surprise is the expression `y/*p` where a student meant to divide `y` by the value pointed to by `p`: the lexer sees the start of a comment and swallows everything up to the next `*/`.",
      "Because the phases run in order, the line numbers the lexer records are counted on the physical source, so error messages still point at the right place even after lines have been spliced. Watch for this in the Tokens panel: the tokens on the spliced line keep their original line numbers.",
    ],
    example: `#include <stdio.h>

/* A backslash-newline is removed in translation phase 2,
   so this macro is one logical line. */
#define LONG_MACRO(a, b) \\
    ((a) * 10 + (b))

int main(void) {
    int x = 4/* a comment becomes one space */+ 2;
    int y = LONG_MACRO(3, 7);
    int z = 1 + \\
            2;          /* line splicing works outside macros too */
    printf("%d %d %d\\n", x, y, z);
    return 0;
}
`,
    tryThis: [
      "Open the Tokens panel and look for the comment on the `int x` line: it is gone, and `4`, `+`, `2` are three ordinary tokens.",
      "Hover the `2` token on the line after `int z = 1 + \\`: its line number is the physical line, even though phase 2 joined it to the previous one.",
      "Replace the `/* a comment becomes one space */` with `/* unterminated` and see which diagnostic the lexer produces.",
    ],
  },
  {
    id: "maximal-munch",
    title: "Maximal munch (why a+++b lexes the way it does)",
    phase: "lex",
    summary:
      "When several tokens could start at the same character, the lexer always takes the longest one.",
    body: [
      "C operators overlap: `+` is a prefix of `++`, `>` is a prefix of `>>` which is a prefix of `>>=`. When the lexer reaches a `+` it has to decide whether the token is `+` or `++`. The rule in C (and in nearly every language) is **maximal munch**: take the longest sequence of characters that forms a valid token. The lexer never backs up to make the parser happier.",
      "That is why `a+++b` is `a++ + b` and not `a + ++b`. The lexer reaches the first `+`, sees another `+`, and munches `++`. The third `+` stands alone. Then the parser applies `a++` (post-increment) and adds `b`. The same logic gives `a---b` the meaning `a-- - b`, and makes `a>>=1` a single compound-assignment token rather than `a >> = 1`.",
      "Maximal munch is purely local and purely greedy. It does not consider whether the result parses. The famous trap `x = y/*p;` is a comment start for this reason, and `0x1e+1` is lexed as one preprocessing number (a pp-number may contain `e+`) and is then a malformed constant rather than `0x1e + 1`. When something lexes strangely, the fix is always to add a space or parentheses to force the token boundary you want.",
      "The example prints every intermediate value so you can confirm which operator sequence the lexer chose. Compare it with the Tokens panel: you will see `a`, `++`, `+`, `b` on the first line, never `a`, `+`, `++`, `b`.",
    ],
    example: `#include <stdio.h>

int main(void) {
    int a = 5, b = 3, c, d, e;
    c = a+++b;        /* lexes as  a++ + b  (c = 8, a becomes 6) */
    d = a---b;        /* lexes as  a-- - b  (d = 3, a becomes 5) */
    e = a>>=1;        /* >>= is one token  (a = 2, e = 2) */
    printf("a=%d b=%d c=%d d=%d e=%d\\n", a, b, c, d, e);
    return 0;
}
`,
    tryThis: [
      "Open the Tokens panel and hover the tokens on the `c = a+++b;` line: there are exactly four operand/operator tokens, `a`, `++`, `+`, `b`.",
      "Rewrite the line as `c = a + ++b;` and run: the output changes because the token boundary moved.",
      "Change `e = a>>=1;` to `e = a>> =1;` and read the error: the lexer now produces `>>` and `=` as separate tokens and the parser rejects it.",
    ],
  },
  {
    id: "keywords-are-identifiers",
    title: "Keywords are identifiers until parsing",
    phase: "lex",
    summary:
      "Keywords have the same shape as identifiers; the lexer tells them apart with a table lookup, and typedef names need help from the parser.",
    body: [
      "An identifier is a letter or underscore followed by letters, digits and underscores. Every keyword, `int`, `if`, `while`, `return`, has exactly that shape. So a lexer does not have a separate rule for each keyword. It recognises the identifier pattern, then looks the spelling up in a small **keyword table**. If it is there, the token kind becomes keyword; otherwise it stays an identifier.",
      "This has three consequences you can see in the example. `if_count` is an identifier: the lookup compares the whole spelling, so a keyword embedded in a longer word is nothing special. `Int` is an identifier because C is case-sensitive and the table contains only `int`. And a keyword can never be a variable name: `int if = 1;` fails because the parser receives a keyword token where it expected an identifier.",
      "There is one place where the simple table is not enough. After `typedef int Length;` the word `Length` names a type, and `Length a = 3;` must parse as a declaration rather than an expression. But `Length` is spelled like any other identifier. C compilers resolve this with the so-called **lexer hack**: the parser records typedef names in its symbol table, and the lexer (or the parser, on lookup) consults it to decide whether an identifier token is a type name. This is the first point where the clean pipeline of lexer then parser has to leak information backwards.",
      "In the Tokens panel you will see the keyword tokens coloured differently from identifiers. Notice that `Length` on the typedef line and `Length` on the declaration line are the same kind of token; only the parser knows the second one is a type.",
    ],
    example: `#include <stdio.h>

typedef int Length;      /* from here on, Length names a type */

int main(void) {
    Length a = 3;        /* a declaration: the parser knows Length is a typedef */
    int if_count = 1;    /* 'if' inside a longer word is just an identifier */
    int Int = 2;         /* case matters: Int is not the keyword int */
    int returned = 3;    /* likewise 'returned' is not 'return' */
    printf("%d %d %d %d\\n", a, if_count, Int, returned);
    return 0;
}
`,
    tryThis: [
      "Open the Tokens panel and compare the kinds of `int` and `Int` on the `int Int = 2;` line.",
      "Rename `if_count` to `if` and read the parser error: the lexer happily produced a keyword token, the parser refused it.",
      "Open the AST panel and find the `Length a = 3;` declaration: the typedef name was resolved to `int`.",
    ],
  },
  {
    id: "regular-languages-and-tokens",
    title: "Regular languages and tokens",
    phase: "lex",
    summary:
      "Every token kind in C can be described by a regular expression, which is why lexers are simple finite automata.",
    body: [
      "The set of valid identifiers, the set of valid integer constants, the set of valid floating constants: each is a **regular language**, one that a finite automaton can recognise without any memory beyond its current state. An identifier is `[A-Za-z_][A-Za-z0-9_]*`. A decimal constant is `[1-9][0-9]*` with optional `u`/`l` suffixes; an octal constant starts with `0`; a hex constant with `0x`. A floating constant has a digit sequence, an optional fraction, an optional exponent, and at least one of the fraction or the exponent.",
      "Because regular languages are closed under union, the lexer can combine all the token patterns into one deterministic automaton and run it over the input in a single pass, in time proportional to the input length. Tools like `lex` and `flex` do exactly that from a list of regular expressions; a hand-written lexer does the same with a `switch` on the first character followed by a loop for the rest.",
      "What regular languages cannot do is count. The lexer cannot check that parentheses balance or that a `{` has a matching `}`; those are context-free properties and belong to the parser. The boundary between lexer and parser is drawn precisely where regular expressions stop being powerful enough.",
      "The example lists several spellings of the same values. `255`, `0xFF` and `0377` match three different patterns but all become the integer 255. `.5`, `25e-1` and `2.5e0` show the optional parts of the floating pattern. The escapes `'\\n'` and `'\\x41'` show that character constants have their own little sub-language of backslash sequences, all of which is still regular.",
    ],
    example: `#include <stdio.h>

int main(void) {
    /* each literal matches a regular expression the lexer knows */
    int dec = 255, hex = 0xFF, oct = 0377;          /* three spellings of 255 */
    unsigned u = 255u;                               /* suffix picks the type */
    long big = 100000L;
    double d1 = 2.5, d2 = .5, d3 = 25e-1, d4 = 2.5e0;
    char c = '\\n', esc = '\\x41';                     /* escape sequences */
    printf("%d %d %d %u %ld\\n", dec, hex, oct, u, big);
    printf("%.1f %.1f %.1f %.1f\\n", d1, d2, d3, d4);
    printf("%d %c\\n", c, esc);
    return 0;
}
`,
    tryThis: [
      "Open the Tokens panel and hover `0xFF`, `0377` and `255`: same kind, same value, different spelling.",
      "Change `0377` to `0378` and read the diagnostic: `8` is not an octal digit, so the pattern fails to match.",
      "Try `double bad = 1e;` and see that an exponent without digits is not a floating constant.",
    ],
  },

  // ───────────────────────────── preprocess ─────────────────────────────
  {
    id: "macros-and-expansion",
    title: "Macros and expansion",
    phase: "preprocess",
    summary:
      "The preprocessor is a textual rewriting engine that runs on tokens before the compiler proper sees them.",
    body: [
      "The **preprocessor** is a separate little language layered on top of C. It works on preprocessing tokens, not on meaning: it has no idea what a variable or a type is. Its main job is **macro expansion**. An object-like macro such as `#define PI 3` replaces every later `PI` token with `3`. A function-like macro such as `#define AREA(r) (PI * (r) * (r))` is invoked with parentheses and substitutes its arguments into its body.",
      "Expansion is recursive: after substituting arguments, the preprocessor rescans the result and expands any macros it finds there, which is how `AREA(2)` ends up as `(3 * (2) * (2))`. A macro is never expanded inside its own expansion, so `#define x x` does not loop forever.",
      'Two operators exist only inside macro bodies. `#` **stringizes** an argument, turning `STR(AREA(2))` into the string literal `"AREA(2)"`; note the argument is not expanded first, which is why the string contains `AREA` and not `3 * 2 * 2`. `##` **pastes** two tokens into one, so `GLUE(var, 12)` produces the single identifier `var12`. Token pasting is how libraries generate families of names.',
      "Finally the preprocessor defines a few macros of its own. `__LINE__` expands to the current line number and `__FILE__` to the file name, which is what `assert` uses to report where it failed. Because expansion happens before parsing, the compiler sees only the result; the Preprocessor lens exists precisely so you can see what the compiler saw.",
    ],
    example: `#include <stdio.h>

#define PI 3                          /* object-like macro */
#define AREA(r) (PI * (r) * (r))      /* function-like macro */
#define STR(x) #x                     /* # stringizes an argument */
#define GLUE(a, b) a##b               /* ## pastes two tokens */

int main(void) {
    int var12 = 7;
    printf("%d\\n", AREA(2));          /* (3 * (2) * (2)) = 12 */
    printf("%s\\n", STR(AREA(2)));     /* "AREA(2)": not expanded first */
    printf("%d\\n", GLUE(var, 12));    /* the identifier var12 */
    printf("line %d\\n", __LINE__);    /* a predefined macro */
    return 0;
}
`,
    tryThis: [
      "Open the Preprocessor lens and read the expanded `main`: there are no macros left, only their replacements.",
      "Open the Tokens panel and find `var12`: after pasting, it is one identifier token.",
      "Change `#define PI 3` to `#define PI 3.0` and watch the type of `AREA(2)` change in the Types panel.",
    ],
  },
  {
    id: "sq-macro-bug",
    title: "Why #define SQ(x) x*x is a bug",
    phase: "preprocess",
    summary:
      "Macros substitute text, not values, so an unparenthesised body interacts with the surrounding expression in surprising ways.",
    body: [
      "A function receives the **value** of its argument. A macro receives the **tokens** of its argument, and it drops them into its body unchanged. `SQ(1+2)` with `#define SQ(x) x*x` therefore becomes `1+2*1+2`, which precedence turns into `1 + (2*1) + 2 = 5`, not the 9 you wanted. The macro never saw a 3.",
      "The problem goes the other way too. Even with the arguments parenthesised, `#define SQ(x) (x)*(x)` is still wrong in `10/SQ(2)`: the expansion is `10/(2)*(2)`, which is `(10/2)*2 = 10`. The body itself must be wrapped: `#define SQ(x) ((x) * (x))`. The rule of thumb is to parenthesise every parameter use and the whole body.",
      "Parentheses do not fix the third problem: side effects. `SQ_OK(n++)` expands to `((n++) * (n++))`, which increments `n` twice and, worse, modifies `n` twice without a sequence point between the modifications, which is undefined behaviour. A macro that evaluates its argument more than once can never be made safe against arguments with side effects; only a real function can.",
      "None of this is visible in the C the compiler receives, which is why these bugs are hard to find. Use the Preprocessor lens to see the expansion, then look at the AST panel to see how the parser grouped the result.",
    ],
    example: `#include <stdio.h>

#define SQ(x) x*x              /* the bug: no parentheses */
#define SQ_OK(x) ((x) * (x))   /* the fix */

int main(void) {
    printf("SQ(1+2)    = %d  (wanted 9)\\n", SQ(1+2));     /* 1+2*1+2 = 5 */
    printf("SQ_OK(1+2) = %d\\n", SQ_OK(1+2));              /* ((1+2)*(1+2)) = 9 */
    printf("10/SQ(2)   = %d  (wanted 2)\\n", 10/SQ(2));    /* 10/2*2 = 10 */
    printf("10/SQ_OK(2)= %d\\n", 10/SQ_OK(2));             /* 10/((2)*(2)) = 2 */
    return 0;
}
`,
    tryThis: [
      "Open the Preprocessor lens and read what `SQ(1+2)` became; then open the AST panel and see the tree the parser built from it.",
      "Fix `SQ` by adding parentheses around each `x` only, and check whether `10/SQ(2)` is right now (it is not).",
      "Change the body to `((x) * (x))` and confirm both lines print the wanted value.",
    ],
  },
  {
    id: "conditional-compilation",
    title: "Conditional compilation and #include guards",
    phase: "preprocess",
    summary:
      "#if, #ifdef and #ifndef let the preprocessor drop whole regions of source, which is how headers protect themselves against double inclusion.",
    body: [
      "The preprocessor can remove code as well as rewrite it. `#if expr` evaluates a constant integer expression using the macros defined so far; if the result is zero, everything up to the matching `#elif`, `#else` or `#endif` is discarded and never reaches the compiler. `#ifdef NAME` is shorthand for `#if defined(NAME)`, and `#ifndef` is its negation. The discarded text is not even parsed, so it may contain code that would not compile.",
      "The most common use is the **include guard**. A header wraps its whole body in `#ifndef POINT_H` / `#define POINT_H` / `#endif`. The first time the header is included, `POINT_H` is undefined, so the body is kept and the macro is defined. If the same header is included again (directly or through another header), the body is skipped, and the `struct Point` definition is not repeated. Without the guard you would get a redefinition error. The example simulates this in a single file by writing the guarded region twice.",
      "Conditional compilation is also how one source file targets several platforms or build configurations: `#ifdef DEBUG` enables extra output, `#if VERSION >= 2` selects a newer code path. The `#elif` chain in the example picks a greeting from three candidates at preprocessing time, so the compiled program contains only one string.",
      "The cost of this flexibility is that the program the compiler sees depends on which macros are defined. The Preprocessor lens shows the surviving text; try toggling `DEBUG` and watching regions appear and disappear.",
    ],
    example: `#include <stdio.h>

#define DEBUG 1
#define VERSION 2

#if VERSION >= 2 && defined(DEBUG)
#  define GREETING "v2 debug build"
#elif VERSION >= 2
#  define GREETING "v2 release build"
#else
#  define GREETING "legacy build"
#endif

/* An include guard: the second copy of this region is skipped. */
#ifndef POINT_H
#define POINT_H
struct Point { int x, y; };
#endif
#ifndef POINT_H
#define POINT_H
struct Point { int x, y; };   /* would be a redefinition without the guard */
#endif

int main(void) {
    struct Point p; p.x = 1; p.y = 2;
    printf("%s %d\\n", GREETING, p.x + p.y);
#ifdef DEBUG
    printf("debug output on\\n");
#endif
    return 0;
}
`,
    tryThis: [
      "Open the Preprocessor lens: only one `struct Point` and one `GREETING` survive.",
      "Delete the `#define DEBUG 1` line and run: the greeting changes and the debug line vanishes.",
      "Remove the second `#ifndef POINT_H` / `#endif` pair (keep the struct) and read the redefinition error.",
    ],
  },

  // ───────────────────────────── parse ─────────────────────────────
  {
    id: "grammars-and-recursive-descent",
    title: "Grammars and recursive descent",
    phase: "parse",
    summary:
      "A context-free grammar describes the structure of programs, and recursive descent turns each grammar rule into a function.",
    body: [
      "The parser consumes the token stream and builds a tree that reflects the nesting of the program. What counts as a valid tree is defined by a **context-free grammar**: a set of rules such as `expr := term ('+' term)*` and `term := digit ('*' digit)*`. Each rule names a non-terminal on the left and says which sequence of tokens and non-terminals it can expand to on the right.",
      "**Recursive descent** is the most direct way to implement such a grammar: write one function per non-terminal, and have each function consume the tokens its rule describes, calling the other functions for the non-terminals it mentions. Because `expr` calls `term` and `term` calls `digit`, and because a parenthesised sub-expression would call `expr` again, the functions are mutually recursive. The call stack of the parser mirrors the tree it is building.",
      "The example is itself a tiny recursive-descent parser, written in C, for sums of products of single digits. `expr` parses a `term` and then loops while it sees `+`; `term` parses a digit and loops while it sees `*`. Because `term` is called from inside `expr`, multiplication is grouped more tightly than addition, which is how the grammar encodes precedence. The program prints 19 because it parsed `2+(3*4)+5`, not `((2+3)*4)+5`.",
      "The real C parser inside this tool works the same way, only with a few hundred rules instead of three. When you open the AST panel you are looking at the tree those functions built. Each node corresponds to one function having returned successfully.",
    ],
    example: `#include <stdio.h>

/* A tiny recursive-descent parser for the grammar
     expr := term ('+' term)*
     term := digit ('*' digit)*                   */
static const char *src = "2+3*4+5";
static int pos = 0;

static int digit(void) { return src[pos++] - '0'; }

static int term(void) {
    int v = digit();
    while (src[pos] == '*') { pos++; v *= digit(); }
    return v;
}

static int expr(void) {
    int v = term();
    while (src[pos] == '+') { pos++; v += term(); }
    return v;
}

int main(void) {
    printf("%s = %d\\n", src, expr());
    return 0;
}
`,
    tryThis: [
      "Open the AST panel and expand `expr`: the `while` loop and the call to `term` are children of the function body, exactly as the grammar rule says.",
      "Set a breakpoint in `term` and step: watch the call stack show `main` → `expr` → `term` → `digit`, mirroring the parse tree.",
      'Change `src` to `"2*3+4*5"` and predict the output before running.',
    ],
  },
  {
    id: "precedence-climbing",
    title: "Precedence climbing for expressions",
    phase: "parse",
    summary:
      "Operator precedence and associativity decide how an expression is grouped, and the parser enforces them with a precedence table.",
    body: [
      "C has fifteen levels of operator precedence. Writing one grammar rule per level works but is slow and verbose, so most C parsers use **precedence climbing** (also called Pratt parsing): parse a primary expression, then look at the next operator; if its precedence is at least the minimum allowed, consume it and parse the right operand with a higher minimum. The single loop handles every binary operator with a table of precedences.",
      "Precedence says which operator binds tighter: `1 + 2 * 3` is 7 because `*` outranks `+`. Two cases trip up almost everyone. The shifts rank below addition, so `1 << 2 + 1` is `1 << 3`. And the comparisons rank above the bitwise operators, so `6 & 3 == 3` is `6 & (3 == 3)`, which is `6 & 1 = 0`. Compilers warn about these because the intended grouping is almost always the other one.",
      "**Associativity** decides the grouping between operators of the same level. Most binary operators are left-associative: `10 - 4 - 3` is `(10 - 4) - 3`. Assignment is right-associative: `a = b = 5` is `a = (b = 5)`, which is why the chained form works at all. The conditional operator also nests to the right, so `a > 3 ? a < 10 ? 1 : 2 : 3` is `a > 3 ? (a < 10 ? 1 : 2) : 3`.",
      "The parser does not evaluate anything; it only decides the tree. The AST panel shows that tree directly, which is the fastest way to settle an argument about how an expression is grouped: find the root operator, and everything below it was parsed first.",
    ],
    example: `#include <stdio.h>

int main(void) {
    int a, b;
    printf("%d\\n", 1 + 2 * 3);        /* * binds tighter: 1 + (2*3) = 7 */
    printf("%d\\n", 10 - 4 - 3);       /* left-assoc: (10-4)-3 = 3 */
    printf("%d\\n", 1 << 2 + 1);       /* + outranks <<: 1 << 3 = 8 */
    printf("%d\\n", 6 & 3 == 3);       /* == outranks &: 6 & 1 = 0 */
    a = b = 5;                        /* right-assoc: a = (b = 5) */
    printf("%d %d\\n", a, b);
    printf("%d\\n", a > 3 ? a < 10 ? 1 : 2 : 3);   /* ?: nests to the right */
    return 0;
}
`,
    tryThis: [
      "Open the AST panel and find the root of `1 << 2 + 1`: it is the `<<` node, with the `+` underneath it.",
      "Look at the `6 & 3 == 3` tree, then add parentheses `(6 & 3) == 3` and watch the tree flip and the output become 1.",
      "Expand `a = b = 5` and confirm the right-hand assignment is nested inside the left one.",
    ],
  },
  {
    id: "declarators-spiral-rule",
    title: "Declarators: the spiral rule (int (*fp)(int))",
    phase: "parse",
    summary:
      "C declarations mirror use, which makes parsing a declarator a matter of reading outward from the name.",
    body: [
      "A C declaration has two parts: a list of **specifiers** such as `int` or `const`, and one or more **declarators** that wrap the name in the same operators you would use to reach a value of the base type. `int *ap[3]` says that `*ap[i]` is an `int`, so `ap` is an array of three pointers to `int`. `int (*pa)[3]` says that `(*pa)[i]` is an `int`, so `pa` is a pointer to an array of three `int`s. The parentheses exist only to override the normal precedence, in which `[]` and `()` bind tighter than `*`.",
      "The **spiral rule** is a reading trick: start at the name, read rightward (`[]` is array of, `()` is function returning) until you hit a closing parenthesis, then read leftward (`*` is pointer to), then jump out of the parentheses and repeat. For `int (*fp)(int)`: `fp` is a pointer to (hit the paren, go out) a function taking `int` and returning `int`. For `int *ap[3]`: `ap` is an array of 3 (nothing more to the right) pointer to `int`.",
      "The parser implements exactly this. It parses the declarator recursively, building the type from the inside out: parse the inner declarator, then apply the array or function suffixes, then apply the pointer prefixes. This is why the C grammar for declarators is recursive and why the type panel shows types as a chain such as `pointer to array[3] of int`.",
      "Types are not only names. `sizeof arr` is 12 because the array type carries its length, while `sizeof pa` is 4 because a pointer is just an address. The program prints both so you can see that the declarator shaped the type and the type decided the size.",
    ],
    example: `#include <stdio.h>

int twice(int x) { return 2 * x; }

int main(void) {
    int arr[3] = {1, 2, 3};
    int *ap[3];              /* ap: array of 3 pointers to int */
    int (*pa)[3] = &arr;     /* pa: pointer to array of 3 ints */
    int (*fp)(int) = twice;  /* fp: pointer to function (int) returning int */
    int i;
    for (i = 0; i < 3; i++) ap[i] = &arr[2 - i];
    printf("%d %d %d\\n", *ap[0], (*pa)[1], fp(21));
    printf("sizeof arr=%d sizeof pa=%d\\n", (int)sizeof arr, (int)sizeof pa);
    return 0;
}
`,
    tryThis: [
      "Open the Types panel and read the type of `ap`, `pa` and `fp` as the compiler spells them out.",
      "Open the AST panel and expand the declaration of `fp`: the declarator tree nests the pointer inside the function type.",
      "Remove the parentheses from `int (*pa)[3]` and read the error: `int *pa[3]` is an array of pointers, which `&arr` cannot initialise.",
    ],
  },
  {
    id: "dangling-else",
    title: "The dangling else",
    phase: "parse",
    summary:
      "When two if statements share one else, the grammar is ambiguous and C resolves it by binding the else to the nearest if.",
    body: [
      "The statement `if (a) if (b) X; else Y;` has two possible parse trees: the `else` could belong to the outer `if` or to the inner one. A grammar that allows both is **ambiguous**, and the C grammar as written in the standard is. Every C compiler resolves it the same way: an `else` attaches to the nearest `if` that does not already have one. This is the **dangling else** rule.",
      "A recursive-descent parser gets this behaviour almost for free. When the function that parses an `if` statement finishes the then-branch, it checks whether the next token is `else`. The inner `if` is parsed inside the outer one, so the inner `if` sees the `else` first and claims it. The outer `if` then finds no `else` waiting.",
      "Indentation has no effect on the parser; it only affects the reader. The first `if` in the example is indented as if the `else` belonged to the outer `if`, but it belongs to the inner one, so with `a` true and `b` false the else-branch runs and prints. The second version uses braces to force the binding the indentation suggests, and its `else` never runs.",
      "This is the reason style guides insist on braces around nested `if` statements. The AST panel is the authoritative answer: find the `else` node and see which `if` it is a child of.",
    ],
    example: `#include <stdio.h>

int main(void) {
    int a = 1, b = 0;

    /* Which if owns this else?  The nearest one. */
    if (a)
        if (b)
            printf("a and b\\n");
    else
        printf("else bound to inner if: b is false\\n");

    /* Braces force the else onto the outer if. */
    if (a) {
        if (b) printf("a and b\\n");
    } else
        printf("never printed: a is true\\n");

    printf("done\\n");
    return 0;
}
`,
    tryThis: [
      "Open the AST panel and expand the first `if`: the `else` branch is inside the inner `if (b)` node.",
      "Set `a = 0` and run: nothing but `done` prints, because the inner `if` is never reached, so neither is its `else`.",
      "Add braces around the first inner `if` the way the indentation suggests and see the output change.",
    ],
  },
  {
    id: "error-recovery",
    title: "Error recovery",
    phase: "parse",
    summary:
      "A good parser keeps going after a syntax error so that it can report several problems per compile instead of just the first.",
    body: [
      "A parser that stops at the first unexpected token is correct but unhelpful: you would fix one typo, recompile, and discover the next. Real parsers practise **error recovery**: they report the error, skip or insert tokens to get back to a state they understand, and continue. The goal is to find genuine further errors without producing a cascade of spurious ones.",
      "The simplest strategy is **panic mode**: on an error, discard tokens until a synchronising token such as `;` or `}` appears, then resume. A missing semicolon after `int x = 1` is recovered by pretending the semicolon was there. A missing `)` in an `if` condition is usually recovered by inserting it. A missing closing brace at the end of a function cannot be recovered locally, because the parser has no way of knowing where the function was supposed to end, so it reports an unexpected end of file.",
      "Recovery is also why later phases must tolerate broken trees. After a syntax error the AST may contain placeholder nodes; semantic analysis is still run so that type errors elsewhere in the file are reported too, but code generation is skipped. The diagnostics you see for one broken file come from several phases cooperating.",
      "The example compiles cleanly. The comment at the top lists three ways to break it. Do them one at a time and read the diagnostics: notice which are reported at the point of the mistake, which are reported further along, and whether the rest of the file is still checked.",
    ],
    example: `#include <stdio.h>

/* This program compiles. Break it on purpose and watch how the
   parser reports each mistake and recovers from it:
     1. delete the ';' after  int x = 1
     2. delete the ')' in the if condition
     3. delete the closing '}' of main                 */
int square(int n) {
    return n * n;
}

int main(void) {
    int x = 1;
    int y = square(x + 2);
    if (y > 5) {
        printf("y = %d\\n", y);
    }
    return 0;
}
`,
    tryThis: [
      "Delete the `;` after `int x = 1` and compile: the error is reported, but notice that `y` and the `if` are still parsed afterwards.",
      "Delete the `)` after `y > 5` and compare where the error is reported with where you made the change.",
      "Make two mistakes at once (steps 1 and 2) and check that both are reported in one compile.",
    ],
  },

  // ───────────────────────────── sema ─────────────────────────────
  {
    id: "symbol-tables-and-scopes",
    title: "Symbol tables and scopes",
    phase: "sema",
    summary:
      "Semantic analysis resolves every name to a declaration using a stack of scopes, which is what makes shadowing work.",
    body: [
      "The parser knows that `x` is an identifier; it does not know which `x`. Resolving names is the first job of **semantic analysis**, and the data structure that does it is the **symbol table**: a map from names to declarations, with one map per scope. Entering a block pushes a new, empty map; leaving the block pops it. Looking up a name searches from the innermost map outward and stops at the first hit.",
      "This search order is exactly the rule for **shadowing**. In the example the file-scope `x` is 1. Inside the first block a new `x` is declared, so lookups inside that block find the inner one and print 2. The nested block declares yet another `x` and prints 3. When that block ends, its map is popped and the next print finds the `x` with value 2 again. None of the inner declarations change the outer variables; they only hide them.",
      "Functions have their own scope stacked on top of file scope, never on top of the caller. That is why `show` prints 1: it is defined at file scope, so its lookup of `x` goes straight to the global, regardless of which `x` is in scope at the call site in `main`. C uses **lexical** (static) scoping: what a name means is decided by where it appears in the source, not by who calls the function.",
      "C actually keeps several symbol tables at once, because struct tags, labels and ordinary identifiers live in separate **name spaces**. `struct x x;` is legal. The Types panel shows the resolution the compiler made for each use of a name.",
    ],
    example: `#include <stdio.h>

int x = 1;               /* file scope */

void show(void) { printf("show sees x=%d\\n", x); }   /* finds the global */

int main(void) {
    printf("x=%d\\n", x);
    {
        int x = 2;       /* a new x shadows the global inside this block */
        printf("x=%d\\n", x);
        {
            int x = 3;   /* and another one shadows that */
            printf("x=%d\\n", x);
        }
        printf("x=%d\\n", x);   /* the inner scope is gone: 2 again */
        show();          /* functions use lexical scope, not the caller's */
    }
    printf("x=%d\\n", x);
    return 0;
}
`,
    tryThis: [
      "Open the Types panel and click each `x`: it tells you which declaration the name resolved to.",
      "Run with the debugger, pause inside the innermost block, and look at the Variables view: all three `x`s exist at once, in different frames of the scope stack.",
      "Rename the innermost `x` to `y` and see the middle `x` become visible again in that block.",
    ],
  },
  {
    id: "type-checking-and-conversions",
    title: "Type checking and the usual arithmetic conversions",
    phase: "sema",
    summary:
      "Every expression gets a type, and when operand types differ the compiler converts them by a fixed set of rules before computing.",
    body: [
      "After names are resolved, semantic analysis computes a **type** for every expression, bottom-up through the AST. Constants have obvious types, variables have their declared type, and operators have rules. The rules matter because the same operator means different things on different types: `/` on two `int`s is integer division (7 / 2 is 3), on `double`s it is real division.",
      "When a binary operator meets two different arithmetic types, C applies the **usual arithmetic conversions**: if either operand is floating, convert the other to that floating type; otherwise, if either is `unsigned`, convert the other to `unsigned`; otherwise both become `int`. So `i / d` converts `i` to `double` and gives 3.5, and the comparison `-1 < u` converts `-1` to `unsigned`, where it becomes 4294967295, making the comparison false. That last one is a notorious bug source.",
      "Before the usual conversions, the **integer promotions** turn anything smaller than `int` (`char`, `short`) into `int`. This is why `sizeof(s + s)` is 4, not 2, and why `s + s` does not overflow even though 60000 does not fit in a `short`: the addition was done in `int`. It is also why `'A' + 1` is the `int` 66 and not a `char`.",
      "A cast is just a conversion you asked for explicitly. `(int)(i / d)` performs the double division first and then truncates. The Types panel annotates every sub-expression with its computed type and marks where implicit conversions were inserted, so you can see exactly which rule applied.",
    ],
    example: `#include <stdio.h>

int main(void) {
    int i = 7;
    double d = 2.0;
    unsigned u = 1;
    short s = 30000;
    printf("%d\\n", i / 2);               /* int / int: integer division = 3 */
    printf("%.1f\\n", i / d);             /* i converted to double: 3.5 */
    printf("%d\\n", (int)(i / d));        /* explicit cast truncates: 3 */
    printf("%d\\n", -1 < u);              /* -1 becomes unsigned: 0 (false!) */
    printf("%d\\n", (int)sizeof(s + s));  /* short promotes to int: 4 */
    printf("%d\\n", s + s);               /* computed in int: 60000, no overflow */
    printf("%d\\n", 'A' + 1);             /* char promotes to int: 66 */
    return 0;
}
`,
    tryThis: [
      "Open the Types panel and hover `i / d`: the left operand carries an implicit conversion to `double`.",
      "Hover `-1 < u` and find the conversion of `-1` to `unsigned int`; then change `u` to a plain `int` and watch the result become 1.",
      "Hover `s + s` and confirm its type is `int`, not `short`.",
    ],
  },
  {
    id: "struct-layout-padding-alignment",
    title: "Struct layout, padding and alignment",
    phase: "sema",
    summary:
      "The compiler places struct members at aligned offsets, inserting padding so each field starts at an address its type can be loaded from.",
    body: [
      "Hardware loads an `int` fastest, or at all, when its address is a multiple of 4, and a `short` when its address is a multiple of 2. Each type therefore has an **alignment**, and the compiler lays out a struct so that every member sits at an offset that is a multiple of its alignment. Where the previous member ends at a bad offset, the compiler inserts invisible **padding** bytes.",
      "In `struct Padded { char c; int i; short s; }` the `char` occupies offset 0. The `int` cannot start at 1, so three padding bytes are inserted and `i` lands at offset 4. The `short` follows at 8. That makes 10 bytes, but the struct as a whole must be a multiple of its largest alignment (4) so that arrays of it keep every element aligned, so two more bytes of tail padding bring `sizeof` to 12.",
      "Order matters. `struct Reordered { int i; short s; char c; }` holds the same three fields but packs them into 8 bytes: `i` at 0, `s` at 4, `c` at 6, one byte of tail padding. And four `char`s need no padding at all, so `struct Packed` is exactly 4 bytes. Sorting members from largest to smallest alignment is a reliable way to minimise padding.",
      "The layout is decided during semantic analysis, because it depends only on types, and it is baked into every later phase: the IR uses member offsets in its address arithmetic, and the generated code adds the constant 4 to reach `p.i`. The program computes offsets with pointer subtraction so you can check the numbers; the Memory panel shows the padding as bytes that are never written.",
    ],
    example: `#include <stdio.h>

struct Packed    { char a, b, c, d; };         /* 4 bytes, no padding */
struct Padded    { char c; int i; short s; };  /* 1 +3 pad + 4 + 2 +2 pad = 12 */
struct Reordered { int i; short s; char c; };  /* 4 + 2 + 1 +1 pad = 8 */

int main(void) {
    struct Packed k;
    struct Padded p;
    struct Reordered r;
    k.a = k.b = k.c = k.d = 0;
    p.c = 1; p.i = 2; p.s = 3;
    r.i = 1; r.s = 2; r.c = 3;
    printf("Packed    size %d\\n", (int)sizeof k);
    printf("Padded    size %d  i at %d, s at %d\\n", (int)sizeof p,
           (int)((char *)&p.i - (char *)&p), (int)((char *)&p.s - (char *)&p));
    printf("Reordered size %d  s at %d, c at %d\\n", (int)sizeof r,
           (int)((char *)&r.s - (char *)&r), (int)((char *)&r.c - (char *)&r));
    return 0;
}
`,
    tryThis: [
      "Open the Types panel and look at `struct Padded`: it lists each member with its offset and the total size.",
      "Run to the end and open the Memory panel on `p`: bytes 1–3 and 10–11 were never written; that is the padding.",
      "Change `int i` in `Padded` to `double i` and predict the new size before running (hint: `double` aligns to 8 here).",
    ],
  },
  {
    id: "lvalues-rvalues-array-decay",
    title: "Lvalues, rvalues and array decay",
    phase: "sema",
    summary:
      "Expressions that name storage are lvalues; in most contexts an array lvalue silently converts to a pointer to its first element.",
    body: [
      "An **lvalue** is an expression that designates an object in memory: `x`, `a[3]`, `*p`, `s.field`. An **rvalue** is just a value: `x + 1`, `5`, `f()`. The left side of an assignment must be an lvalue, because the compiler needs an address to store into. The right side is converted to an rvalue: its current value is loaded. In `x = x + 1` the same name is used both ways, and the Types panel marks the two uses differently.",
      "Arrays are the strange case. An array name is an lvalue of array type, but in almost every expression it undergoes **array-to-pointer decay**: it is converted to an rvalue pointer to its first element. So `int *p = a` is fine, `sum(a, 10)` passes a pointer, and `a + 5` is pointer arithmetic. The exceptions are `sizeof a` and `&a`, which see the whole array, which is why `sizeof a` is 40.",
      "Decay is also why a function cannot receive an array by value. A parameter declared `int a[10]` is adjusted to `int *a` by the compiler; the 10 is ignored. Inside `size_of_param`, `sizeof a` is therefore 4, the size of a pointer. The function cannot know how long the array was, so C programs always pass the length separately.",
      "Semantic analysis is where these conversions are made explicit. The AST produced by the parser just says `a`; the type-annotated tree says `a`, converted to `int *`, and later phases work only with the explicit form. Look for the decay nodes in the Types panel.",
    ],
    example: `#include <stdio.h>

int sum(int *p, int n) { int s = 0, i; for (i = 0; i < n; i++) s += p[i]; return s; }
int size_of_param(int a[10]) { return (int)sizeof a; }   /* a is really int * */

int main(void) {
    int a[10] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
    int x = 5;
    int *p = a;                 /* a decays to &a[0] */
    x = x + 1;                  /* left x: lvalue (store); right x: rvalue (load) */
    printf("%d %d\\n", (int)sizeof a, size_of_param(a));   /* 40 vs 4 */
    printf("%d %d\\n", sum(a, 10), sum(a + 5, 5));          /* pointer arithmetic */
    printf("%d %d\\n", *p, p[9]);
    printf("%d\\n", x);
    return 0;
}
`,
    tryThis: [
      "Open the Types panel and hover `a` in `sum(a, 10)` and in `sizeof a`: one has type `int *`, the other `int[10]`.",
      "Hover the parameter `a` of `size_of_param`: its declared type `int[10]` was adjusted to `int *`.",
      "Try `x + 1 = 7;` and read the error: an rvalue cannot be assigned to.",
    ],
  },

  // ───────────────────────────── ir ─────────────────────────────
  {
    id: "three-address-code",
    title: "Three-address code and basic blocks",
    phase: "ir",
    summary:
      "The compiler lowers the tree into a flat list of simple instructions, each with one operator and at most three operands, grouped into straight-line blocks.",
    body: [
      "The AST is a good shape for checking a program but a poor shape for optimising or generating code for it: it is nested, and every operator has to be handled in context. So the compiler **lowers** the tree into an **intermediate representation** (IR). The classic form is **three-address code**: a sequence of instructions like `t1 = a + b`, each with one operation, a destination and at most two sources. Compound expressions are broken up with fresh temporaries.",
      "The one-line assignment in the example becomes about six IR instructions: `t1 = a + b`, `t2 = c - d`, `t3 = t1 * t2`, `t4 = t3 / 2`, `t5 = a % b`, `r = t4 + t5`. The nesting of the tree has been turned into the order of the list. Each temporary is defined exactly once and the evaluation order, which the tree left implicit, is now explicit.",
      "Instructions are grouped into **basic blocks**: maximal straight-line runs with one entry at the top and one exit at the bottom. Control can only enter a block at its first instruction and only leave at its last (a branch, jump or return). Inside a block every instruction executes if the first one does, which is what makes blocks the unit that optimisation passes reason about.",
      "This tool’s IR is typed and uses explicit `load` and `store` instructions for variables that live in memory, so before optimisation you will see each use of `a` as a load from `a`’s stack slot. Open the IR panel and match each line of C to the instructions it produced.",
    ],
    example: `#include <stdio.h>

int main(void) {
    int a = 6, b = 4, c = 9, d = 3;
    int r;
    /* One source expression becomes several IR instructions,
       each with one operator and a fresh temporary:
         t1 = a + b      t2 = c - d      t3 = t1 * t2
         t4 = t3 / 2     t5 = a % b      r  = t4 + t5   */
    r = (a + b) * (c - d) / 2 + a % b;
    printf("%d\\n", r);
    return 0;
}
`,
    tryThis: [
      "Open the IR panel and count the instructions produced by the `r = ...` line; compare with the six listed in the comment.",
      "Step through the IR instruction by instruction and watch the temporaries take their values.",
      "Add parentheses to change the grouping, for example `(a + b) * ((c - d) / 2)`, and see which temporaries change order.",
    ],
  },
  {
    id: "control-flow-graphs",
    title: "Control-flow graphs",
    phase: "ir",
    summary:
      "Basic blocks and the branches between them form a directed graph, the structure every later analysis walks.",
    body: [
      "Once a function is a set of basic blocks, the branches at the end of each block define edges to other blocks. The blocks and edges together form the **control-flow graph** (CFG). It has a single entry block and the possible executions of the function are exactly the paths through the graph. Loops in the source become cycles in the graph; `if`/`else` becomes a diamond that splits and rejoins.",
      "The example has a `while` loop with a `break` and a `continue`, which produce the three kinds of edge worth recognising. The loop **header** block tests `i < 10` and has two successors: the loop body and the exit. The `break` creates a second edge to the exit block from the middle of the body. The `continue` creates a second **back edge** to the header. After the `if (i % 2 == 0)` diamond, the `odds += i` block has only the ordinary edge to the header.",
      "A block’s **predecessors** are the blocks that can branch to it and its **successors** are the blocks it can branch to. Analyses such as liveness, dominance and reaching definitions are all defined over these edges, and the shape of the graph is what an optimiser means by a loop: a header that **dominates** a set of blocks, one of which has a back edge to it.",
      "The IR panel lists blocks with labels and shows the branch instruction at the end of each. Reading the successors off the branches lets you draw the graph by hand; a good exercise is to do that for this program and check the number of edges into the header (there should be three: entry, the `continue`, and the normal bottom of the loop).",
    ],
    example: `#include <stdio.h>

int main(void) {
    int i = 0, evens = 0, odds = 0;
    while (i < 10) {                 /* header: two successors */
        i++;
        if (i == 7) break;           /* extra edge out of the loop */
        if (i % 2 == 0) {
            evens += i;
            continue;                /* extra back edge to the header */
        }
        odds += i;
    }                                /* normal back edge */
    printf("evens=%d odds=%d stopped at %d\\n", evens, odds, i);
    return 0;
}
`,
    tryThis: [
      "Open the IR panel and find the block that tests `i < 10`; list every block whose last instruction branches to it.",
      "Find the exit block (the one with the `printf` call) and count its predecessors: the header and the `break`.",
      "Delete the `continue;` line and see one back edge disappear from the graph.",
    ],
  },
  {
    id: "ssa-form-and-phi-nodes",
    title: "SSA form and phi nodes",
    phase: "ir",
    summary:
      "In static single assignment form every variable is assigned exactly once, and phi nodes choose a value where control-flow paths merge.",
    body: [
      "Three-address code lets a variable be assigned many times, so to know what `label` holds at the `return` you must trace which assignments can reach it. **Static single assignment** (SSA) form removes that work by renaming: each assignment creates a new version, `label1`, `label2`, `label3`, and every use refers unambiguously to one definition. The definition is then the single place to look for the value, which makes most optimisations simpler and faster.",
      "Renaming breaks down where paths merge. After the `if`/`else if`/`else` chain in `classify`, which version of `label` reaches the `return`? The answer depends on which path was taken, so SSA introduces a **phi node** at the merge block: `label4 = phi(label1, label2, label3)`. A phi is not a real instruction; it says “take the value from whichever predecessor we arrived from”. Code generation later turns it into copies at the ends of the predecessor blocks.",
      "Loops need phis too. `acc` in `main` is assigned before the loop and again inside it, and the header block is reached both from the entry and from the back edge. So the header gets `acc2 = phi(acc1 from entry, acc3 from the body)`, and likewise for `i`. Every loop-carried variable shows up as a phi in the loop header, which is one way to spot induction variables.",
      "In this tool SSA is built by the `mem2reg` pass, so the IR panel shows the un-renamed, load/store form before optimisation and the phi form after. Switch the Optimize panel on and compare: the `label` variable’s stack slot disappears and a phi with three incoming values appears at the top of the return block.",
    ],
    example: `#include <stdio.h>

int classify(int n) {
    int label;                 /* assigned on three paths, read after they merge */
    if (n < 0) label = -1;
    else if (n == 0) label = 0;
    else label = 1;
    return label * 100;        /* here: label = phi(-1, 0, 1) */
}

int main(void) {
    int i, acc = 0;            /* acc and i get phis in the loop header */
    for (i = -2; i <= 2; i++) acc += classify(i) + 1;
    printf("%d\\n", acc);
    return 0;
}
`,
    tryThis: [
      "Open the IR panel before and after `mem2reg`: find the phi in `classify` and read its three incoming values and blocks.",
      "Find the loop header in `main` and count the phi nodes (one for `i`, one for `acc`).",
      "Remove the `else if (n == 0)` branch and see the phi shrink to two incoming values.",
    ],
  },

  // ───────────────────────────── opt ─────────────────────────────
  {
    id: "mem2reg",
    title: "mem2reg: from memory to registers",
    phase: "opt",
    summary:
      "The first optimisation promotes local variables from stack slots to SSA values, deleting their loads and stores.",
    body: [
      "The lowering pass gives every local variable a slot in the stack frame and turns each read into a `load` and each write into a `store`. That is correct and simple, but it means `total = total + i * i` costs two loads and a store per iteration, and no other optimisation can reason about `total` because its value lives in memory. **mem2reg** (memory to register) fixes this: for each slot whose address is never taken, it replaces the loads and stores with SSA values and phi nodes, and deletes the slot.",
      "The condition matters. If a variable’s address escapes, through `&escaped` in the example, some pointer somewhere might read or write it, and the compiler cannot track that through a plain SSA value. So `escaped` keeps its stack slot and its loads and stores, while `total` and `i`, whose addresses are never taken, are promoted. This is why taking the address of a variable, even just once, can make the code around it slower.",
      "mem2reg is the pass that constructs SSA form. It finds, for each promotable slot, the blocks where it is stored, uses the dominance frontier to decide where phi nodes are needed, and then walks the dominator tree renaming every use to the reaching definition. The output has no loads or stores for promoted variables at all.",
      "Nearly every later optimisation depends on this one: constant propagation needs to see that a value is a constant, not a load; CSE needs to see that two expressions use the same value, not two loads from the same address. Turn only mem2reg on in the Optimize panel and count how many instructions disappear from the loop.",
    ],
    example: `#include <stdio.h>

int main(void) {
    int total = 0;           /* address never taken: promoted to a register */
    int i;
    int escaped = 10;        /* &escaped is taken below: stays in memory */
    int *keep = &escaped;
    for (i = 1; i <= 5; i++) total = total + i * i;
    *keep += 1;
    printf("%d %d\\n", total, escaped);
    return 0;
}
`,
    tryThis: [
      "Open the Optimize panel, enable only `mem2reg`, and compare the loop before and after: the loads and stores of `total` and `i` are gone.",
      "Find `escaped` in the optimised IR: its `alloca`, `load` and `store` are still there because its address escaped.",
      "Delete the `int *keep = &escaped;` and `*keep += 1;` lines and see `escaped` get promoted as well.",
    ],
  },
  {
    id: "constant-folding-and-propagation",
    title: "Constant folding and propagation",
    phase: "opt",
    summary:
      "Arithmetic on constants is evaluated at compile time, and known constant values are substituted into their uses so more folding becomes possible.",
    body: [
      "**Constant folding** evaluates an instruction whose operands are all constants and replaces it with the result. `80 * 25` becomes `2000`, `60 * 60 * 24` becomes `86400`, and `(3 > 2) && (10 / 2 == 5)` becomes `1`. The compiler has to be careful to compute with the same width and signedness the program would, which is why `int` arithmetic is folded in 32 bits and floating arithmetic uses the target’s rounding.",
      "**Constant propagation** is the partner pass. When an SSA value is known to be a constant, every use of it is replaced by the constant. `cells` is `2000` after folding, so `cells * 4 + 16` becomes `2000 * 4 + 16`, which folds to `8016`. Each pass enables the other, which is why optimisers run them to a fixed point rather than once.",
      "Propagation needs SSA. In the un-promoted IR, `cells` is a store followed by a load, and the load could in principle return anything if some pointer wrote to the slot. After `mem2reg` the use of `cells` refers directly to the constant-producing instruction, and propagation is a trivial substitution. Look at the optimised IR for `y`: `x * 2 + 1` has become the literal `11` because `x` was propagated and the result folded.",
      "Macros are the usual source of foldable expressions in C: `WIDTH * HEIGHT` is textually `80 * 25` after preprocessing, and programmers rely on the compiler to fold it. In the fully optimised program there is no arithmetic left in `main` at all, only the five constants being passed to `printf`.",
    ],
    example: `#include <stdio.h>

#define WIDTH 80
#define HEIGHT 25

int main(void) {
    int cells = WIDTH * HEIGHT;         /* folded: 2000 */
    int bytes = cells * 4 + 16;         /* propagated then folded: 8016 */
    int secs = 60 * 60 * 24;            /* folded: 86400 */
    int flag = (3 > 2) && (10 / 2 == 5);   /* folded: 1 */
    int x = 5;
    int y = x * 2 + 1;                  /* propagated then folded: 11 */
    printf("%d %d %d %d %d\\n", cells, bytes, secs, flag, y);
    return 0;
}
`,
    tryThis: [
      "Open the Optimize panel and look at the final IR of `main`: there should be no arithmetic instructions, only constants passed to `printf`.",
      "Disable `mem2reg` and re-enable folding only: `secs` still folds, but `bytes` and `y` do not, because their inputs are loads.",
      "Change `int x = 5;` to read `x` from `scanf` and watch `y` stop folding.",
    ],
  },
  {
    id: "dce-and-cse",
    title: "Dead code elimination and CSE",
    phase: "opt",
    summary:
      "Instructions whose results are never used are deleted, and expressions computed twice with the same operands are computed once.",
    body: [
      "**Dead code elimination** (DCE) removes instructions that cannot affect the program’s output. The simplest kind is an instruction whose result is never used and which has no side effects: `unused = w * h * 2` in the example is computed and then forgotten, so after `mem2reg` the multiplications have no users and are deleted. The pass works backwards: anything a live instruction depends on is also live, and whatever is left is dead.",
      'The other kind is **unreachable code**. `if (0)` branches on a constant, so the optimiser replaces the conditional branch with an unconditional one, and the block containing the `printf("unreachable")` has no predecessors any more. A CFG simplification pass deletes blocks with no predecessors. Together these mean you can leave debugging code behind an `if (DEBUG)` without paying for it.',
      "**Common subexpression elimination** (CSE) looks for two instructions with the same operator and the same operands and replaces the second with the first. `w * h` is computed for `a` and again for `b`; after CSE there is one multiply and `b` is `t + 1` where `t` is the shared result. CSE relies on SSA to know the operands are the same values, not just the same names, and on the fact that pure arithmetic has no side effects.",
      "Both passes are cheap and are run many times, because every other pass creates new dead code and new common subexpressions. Enable them one at a time in the Optimize panel and watch the instruction count of `area` fall.",
    ],
    example: `#include <stdio.h>

int area(int w, int h) {
    int unused = w * h * 2;     /* dead: never read, so DCE removes it */
    int a = w * h;
    int b = w * h + 1;          /* w * h again: CSE reuses the first result */
    if (0) printf("unreachable\\n");   /* dead branch: the block is removed */
    return a + b;
}

int main(void) {
    printf("%d\\n", area(6, 7));
    return 0;
}
`,
    tryThis: [
      "Open the Optimize panel and enable `mem2reg` and DCE: the two multiplies that fed `unused` disappear.",
      "Enable CSE and count the `mul` instructions in `area`: there should be exactly one.",
      "Change `if (0)` to `if (w)` and see the branch and its block come back, because the condition is no longer constant.",
    ],
  },
  {
    id: "loop-invariant-code-motion",
    title: "Loop-invariant code motion",
    phase: "opt",
    summary:
      "A computation whose operands do not change inside a loop is moved out of the loop so it runs once instead of every iteration.",
    body: [
      "The expression `k * 7` inside the loop in the example uses only `k`, which is never modified inside the loop. Its value is therefore the same on every iteration; it is **loop-invariant**. Computing it eight times is wasteful, so **loop-invariant code motion** (LICM) hoists it into a block that runs once before the loop, called the **preheader**, and every use inside the loop refers to the hoisted result.",
      "Deciding what is invariant is a fixed-point computation. An instruction is invariant if every operand is either a constant, defined outside the loop, or itself invariant. `k * 7` qualifies at once. `i * scale` does not, because `i` changes each iteration. `a[i]` likewise depends on `i`. The pass marks instructions invariant until nothing changes, then hoists them in dependency order so that an invariant that uses another invariant is hoisted after it.",
      "Hoisting must also be safe. Moving an instruction to the preheader executes it even if the loop body runs zero times, so instructions that could trap, like a division by a possibly-zero value or a load through a possibly-bad pointer, are hoisted only when the optimiser can prove the loop executes at least once or that the operation cannot fault. Pure arithmetic such as multiplication is always safe to hoist.",
      "In the Optimize panel, look at the loop body before and after LICM: the `mul` by 7 moves out of the loop, leaving one multiply, one store and one add per iteration. On a real machine this is the difference between a loop that fits in registers and one that does not.",
    ],
    example: `#include <stdio.h>

int main(void) {
    int i, k = 6, sum = 0;
    int a[8];
    for (i = 0; i < 8; i++) {
        int scale = k * 7;      /* loop-invariant: hoisted to the preheader */
        a[i] = i * scale;       /* depends on i: must stay in the loop */
        sum += a[i];
    }
    printf("%d\\n", sum);
    return 0;
}
`,
    tryThis: [
      "Open the Optimize panel, enable `mem2reg` and LICM, and find the `mul ... 7` instruction: it is now in the block before the loop header.",
      "Add `k++;` at the end of the loop body and confirm the multiply is no longer hoisted.",
      "Count the instructions in the loop body before and after LICM.",
    ],
  },
  {
    id: "strength-reduction",
    title: "Strength reduction",
    phase: "opt",
    summary:
      "Expensive operations are replaced with cheaper ones that give the same result, such as shifts for multiplication by powers of two.",
    body: [
      "Not all instructions cost the same. On most processors a shift or an add takes one cycle, a multiply takes several, and a division takes tens. **Strength reduction** replaces an expensive operation with a cheaper equivalent when the operands allow it. Multiplying by 8 is the same as shifting left by 3, so `i * 8` becomes `i << 3`. Multiplying by 2 can become `x + x`.",
      "Division is where the pass pays off most, but it needs care. For an **unsigned** value, `u / 4` is exactly `u >> 2` and `u % 4` is exactly `u & 3`. For a signed value those identities are false when the value is negative, because C division truncates toward zero and a right shift rounds toward minus infinity: `-7 / 4` is `-1` but `-7 >> 2` is `-2`. So the optimiser reduces only unsigned division by a power of two, or adds a fix-up sequence for signed values. The example uses an `unsigned` deliberately so you can see the shift appear.",
      "The simplest reductions are the **algebraic identities**: `x * 1` and `x + 0` are just `x`, `x * 0` is `0`, `x - x` is `0`. These show up constantly after other passes have substituted constants into expressions, which is why strength reduction is run alongside folding rather than once.",
      "A more ambitious form of strength reduction targets loops: an induction variable multiplied by a constant on every iteration, such as `i * 8` as an array index, can be replaced by a second variable that is simply incremented by 8 each time. That turns the multiply into an add. This tool implements the per-instruction reductions; look in the Optimize panel for the `shl`, `shr` and `and` instructions that replace `mul`, `udiv` and `urem`.",
    ],
    example: `#include <stdio.h>

int main(void) {
    unsigned u = 100;
    int i, total = 0;
    for (i = 1; i <= 4; i++) {
        total += i * 8;          /* i * 8  becomes  i << 3 */
    }
    printf("%d\\n", total);
    printf("%u %u\\n", u / 4, u % 4);          /* unsigned: >> 2 and & 3 */
    printf("%d %d\\n", total * 1, total + 0);  /* identities: just total */
    printf("%d\\n", total * 2);                /* total + total, or << 1 */
    return 0;
}
`,
    tryThis: [
      "Open the Optimize panel and find the `shl` that replaced `i * 8` in the loop.",
      "Change `unsigned u` to `int u` and see the division by 4 stay a division (or grow a fix-up), because the shift would be wrong for negatives.",
      "Find what happened to `total * 1` and `total + 0`: there should be no instruction at all.",
    ],
  },
  {
    id: "inlining",
    title: "Inlining",
    phase: "opt",
    summary:
      "A call to a small function is replaced by a copy of its body, removing call overhead and exposing the body to the other passes.",
    body: [
      "A function call costs more than the instructions inside it: arguments must be moved into place, the return address saved, a frame set up and torn down, and the result moved out. For a function as small as `sq`, that overhead is larger than the work. **Inlining** replaces the call with a copy of the callee’s body, substituting the arguments for the parameters, so `cube(i)` becomes `i * i * i` with no calls at all.",
      "Removing the call is only half the benefit. Once the body is in the caller, every other optimisation can see through it. Constants passed as arguments propagate into the copy, common subexpressions between caller and callee can be shared, and a loop that called a function now contains plain arithmetic that LICM and strength reduction can work on. Inlining is usually the first pass in a pipeline for this reason.",
      "It cannot be applied everywhere. Inlining a large function at many call sites bloats the program, which costs instruction cache and compile time, so inliners use a size threshold and a cost model. Recursive functions cannot be fully inlined. And inlining `cube` means also inlining its call to `sq`, so the pass works transitively, usually bottom-up through the call graph.",
      "In the Optimize panel, enable the inliner and look at `main`: the loop body no longer contains a `call`. With all passes on, `sq` and `cube` may disappear entirely because nothing calls them any more and they are `static`, so no other file could.",
    ],
    example: `#include <stdio.h>

static int sq(int x) { return x * x; }
static int cube(int x) { return sq(x) * x; }   /* after inlining: x * x * x */

int main(void) {
    int i, s = 0;
    for (i = 1; i <= 4; i++) s += cube(i);     /* no call left after inlining */
    printf("%d\\n", s);
    return 0;
}
`,
    tryThis: [
      "Open the Optimize panel, enable only inlining, and look at `main`: the `call cube` is replaced by two multiplies.",
      "Open the Assembly panel with all optimisations on and search for `call`: only the `printf` call should remain.",
      "Make `cube` recursive (for example return `cube(x - 1) * x` with a base case) and see the inliner stop at it.",
    ],
  },

  // ───────────────────────────── codegen ─────────────────────────────
  {
    id: "instruction-selection",
    title: "Instruction selection",
    phase: "codegen",
    summary:
      "Each IR instruction is mapped to one or more machine instructions, with attention to which immediates and addressing modes the target supports.",
    body: [
      "The IR is machine-independent; `add r, a, 1` could run anywhere. **Instruction selection** is the pass that picks the real instructions of the target, here RISC-V RV32. Most IR operations map one-to-one: an IR `add` becomes an `add`, a `mul` becomes a `mul`, a signed divide becomes `div`. The interesting cases are where the target’s instruction set is less flexible than the IR.",
      "RISC-V has no instruction that adds an arbitrary 32-bit constant. `addi` takes a 12-bit signed immediate, in the range −2048 to 2047, so `a + 1` is a single `addi` but `r - 5000` is not: the selector must notice that 5000 does not fit and materialise the constant into a register first, `li t0, 5000` (which itself expands to `lui` plus `addi`), followed by `sub`. Likewise `r + 100000` needs a `lui`/`addi` pair to build the constant before the `add`. Small constants ride inside the instruction; large ones cost extra instructions.",
      "Selection also decides how to form addresses (`lw` takes a base register plus a 12-bit offset, so a struct field at offset 4 is a single load but an array element at a variable index needs a shift and an add first), how to compare (RISC-V has `slt` but no `sgt`, so operands are swapped), and how to branch (`beq`, `bne`, `blt` compare and branch in one instruction, so a compare feeding a branch is folded into it).",
      "The Assembly panel shows the selected instructions before register allocation, with virtual register names like `v7`. Each line is annotated with the source line it came from, so you can see exactly which C expression produced the `lui`.",
    ],
    example: `#include <stdio.h>

int main(void) {
    int a = 1000, b = 7, r;
    r = a + 1;            /* small immediate: one addi */
    r += a * b;           /* mul */
    r -= 5000;            /* 5000 does not fit in 12 bits: li + sub */
    r = r + 100000;       /* lui + addi to build the constant, then add */
    r = r / 3;            /* div */
    printf("%d\\n", r);
    return 0;
}
`,
    tryThis: [
      "Open the Assembly panel and find the instruction for `r = a + 1`: a single `addi`.",
      "Find the instructions for `r -= 5000` and `r = r + 100000`: the constant is built in a register first.",
      "Change `5000` to `2000` and see the `li` disappear, because 2000 fits in a 12-bit immediate.",
    ],
  },
  {
    id: "calling-conventions",
    title: "Calling conventions (RISC-V a0–a7, the stack frame)",
    phase: "codegen",
    summary:
      "The ABI fixes which registers carry arguments and results and who must preserve what, so that separately compiled functions can call each other.",
    body: [
      "A function and its caller may be compiled separately, so they need an agreement about where arguments go, where the result comes back, and which registers a call may destroy. That agreement is the **calling convention**, part of the platform ABI. On RISC-V the first eight integer arguments travel in registers `a0` to `a7`, the return value comes back in `a0` (and `a1` for 64-bit results), and any further arguments are pushed on the stack by the caller.",
      "`sum10` has ten parameters, so the first eight are in `a0`–`a7` and the ninth and tenth are stored on the stack by `main` just before the `call`. Inside `sum10` the callee reads them with `lw` from a positive offset off the stack pointer. The Assembly panel for `main` shows the eight register moves and two stack stores; the panel for `sum10` shows the matching loads.",
      "Registers are divided into **caller-saved** (`t0`–`t6`, `a0`–`a7`): the callee may overwrite them freely, so a caller that needs a value across a call must save it, and **callee-saved** (`s0`–`s11`, `sp`): a function that uses them must restore them before returning. The return address register `ra` is set by `call` and must be saved by any function that itself makes calls, which is why `main` saves `ra` and `sum10` does not need to.",
      "These rules are what makes the stack frame layout work: incoming stack arguments sit just above the frame, saved registers and locals inside it, and outgoing arguments at the bottom where the next callee expects them. Everything about the convention is visible in the generated code; nothing about it is in the C source.",
    ],
    example: `#include <stdio.h>

/* Eight arguments ride in a0-a7; the ninth and tenth go on the stack. */
int sum10(int a, int b, int c, int d, int e, int f, int g, int h, int i, int j) {
    return a + b + c + d + e + f + g + h + i + j;
}

int main(void) {
    int r = sum10(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    printf("%d\\n", r);     /* the result came back in a0 */
    return 0;
}
`,
    tryThis: [
      "Open the Assembly panel on `main` and find the `li a0, 1` through `li a7, 8` sequence, then the two `sw` instructions that place 9 and 10 on the stack.",
      "Look at `sum10` and find the two `lw` instructions that fetch the stack arguments.",
      "Step through the call in the simulator and watch `a0` change from the first argument to the return value.",
    ],
  },
  {
    id: "register-allocation",
    title: "Register allocation: linear scan vs spilling everything",
    phase: "codegen",
    summary:
      "Infinitely many virtual registers must be mapped onto a few real ones; the values that do not fit are spilled to the stack.",
    body: [
      "Instruction selection pretends there are unlimited registers and names them `v0`, `v1`, and so on. **Register allocation** assigns each virtual register to one of the real ones, `t0`–`t6`, `s0`–`s11`, `a0`–`a7`, in a way that two values which are alive at the same time never share a register. When there are more simultaneously live values than registers, some must be **spilled**: stored to a stack slot after they are defined and reloaded before each use.",
      "The naive strategy, called **spill everything**, gives every virtual register a stack slot and loads and stores around every instruction. It is trivially correct and needs only a couple of scratch registers, but the generated code is dominated by memory traffic. This is roughly what an unoptimised compiler produces, and it is why `-O0` code is so slow.",
      "**Linear scan** does much better with little effort. It computes each virtual register’s **live interval**, the range of instruction numbers from its definition to its last use, sorts the intervals by start, and walks them in order, handing each a free register and freeing registers whose intervals have ended. When no register is free it spills the interval that ends furthest in the future. The example keeps eight accumulators plus a loop counter live across the loop, which is comfortable for linear scan but produces a storm of loads and stores under the naive allocator.",
      "The Assembly panel can show both allocations. Compare the loop body: the naive version has an `lw` before and an `sw` after almost every arithmetic instruction; the linear-scan version has none, because all nine values fit in registers. Real compilers use graph colouring or more elaborate variants of linear scan, but the trade-off is the same: fewer spills in exchange for more analysis.",
    ],
    example: `#include <stdio.h>

int main(void) {
    /* nine values are live at once inside the loop */
    int a = 1, b = 2, c = 3, d = 4, e = 5, f = 6, g = 7, h = 8;
    int i, r = 0;
    for (i = 0; i < 4; i++) {
        a += b; b += c; c += d; d += e;
        e += f; f += g; g += h; h += a;
        r += a + b + c + d + e + f + g + h;
    }
    printf("%d\\n", r);
    return 0;
}
`,
    tryThis: [
      "Open the Assembly panel with the naive allocator and count the `lw`/`sw` instructions inside the loop; then switch to linear scan and count again.",
      "Look at the allocation report: linear scan should report zero spills for this function.",
      "Add six more accumulators to the loop and see linear scan start spilling.",
    ],
  },
  {
    id: "prologue-epilogue-frame-pointer",
    title: "Prologue, epilogue and the frame pointer",
    phase: "codegen",
    summary:
      "Every function begins by building its stack frame and ends by tearing it down; the frame pointer gives locals a stable address inside it.",
    body: [
      "The first instructions of a compiled function are its **prologue**: decrement the stack pointer to reserve the frame, save the return address `ra` and any callee-saved registers the function will use, and, if a frame pointer is used, save the old `s0`/`fp` and set the new one to point into the frame. The last instructions are the **epilogue**, which do the reverse and finish with `ret` (a jump to `ra`). Everything in between is the body.",
      "The frame holds the function’s locals that live in memory, such as the array `local[4]` in the example, spilled registers, and space for outgoing stack arguments. Locals are addressed as an offset from the **frame pointer** (`s0`) or, when the frame size is fixed, from `sp` directly. The frame pointer is what lets a debugger walk the stack: each frame’s saved `fp` points at the previous frame.",
      "Recursion makes frames visible. Each call to `depth` runs the prologue again, so five nested calls have five frames on the stack, each with its own `local` array and its own saved `ra`. The epilogue of the innermost call pops its frame, returns to the middle of the next one up, and so on. Stack overflow is simply running out of room for new frames.",
      "In the Assembly panel the prologue is the `addi sp, sp, -N` followed by the `sw ra` and `sw s0`; the epilogue mirrors it before `ret`. Run the program in the simulator and open the Memory panel on the stack segment to watch the frames stack up and unwind.",
    ],
    example: `#include <stdio.h>

int depth(int n) {
    int local[4];            /* lives in this call's stack frame */
    local[0] = n;
    if (n == 0) return 0;
    return local[0] + depth(n - 1);   /* a new frame per recursive call */
}

int main(void) {
    printf("%d\\n", depth(5));   /* 5 + 4 + 3 + 2 + 1 */
    return 0;
}
`,
    tryThis: [
      "Open the Assembly panel on `depth` and read its prologue: how many bytes does it reserve, and which registers does it save?",
      "Set a breakpoint at `local[0] = n;`, run, and watch the call stack and the stack segment in the Memory panel grow by one frame each time you continue.",
      "Change `int local[4]` to `int local[64]` and see the frame size in the prologue grow to match.",
    ],
  },

  // ───────────────────────────── run ─────────────────────────────
  {
    id: "process-memory-model",
    title: "The process memory model (text/rodata/data/bss/heap/stack)",
    phase: "run",
    summary:
      "A running program’s address space is divided into segments, and where a variable lives is decided by how it is declared.",
    body: [
      "When a program runs, its address space is laid out in **segments**. The **text** segment holds the machine code, read-only. **rodata** holds read-only data such as string literals, which is why writing through `greeting` is undefined. **data** holds global and static variables with an initialiser, such as `counter = 42`; their initial bytes are copied from the executable. **bss** holds globals without an initialiser, such as `table`; it is simply zeroed at start-up, which is why uninitialised globals are reliably zero while uninitialised locals are not.",
      "Two segments grow while the program runs. The **heap** holds everything from `malloc`; it grows upward as the allocator asks the system for more. The **stack** holds each function’s frame, locals included, and grows downward with every call. The two grow toward each other, and the gap between them is the free address space.",
      "Each kind of storage has a lifetime that follows from its segment. Globals live for the whole run. Locals live until their function returns, at which point their stack slots are reused by the next call, which is why returning the address of a local is a bug. Heap blocks live until `free`, which is why forgetting `free` is a leak.",
      "The example declares one variable of each kind. Run it and open the Memory panel: `counter` is in data, `table` in bss, the string in rodata, `local` in the stack, and the `malloc` block in the heap. The addresses differ by segment, and the panel colours each one.",
    ],
    example: `#include <stdio.h>
#include <stdlib.h>

int counter = 42;              /* .data: initialised global */
int table[100];                /* .bss: zero-filled at start-up */
const char *greeting = "hi";   /* the characters live in .rodata */

int main(void) {
    int local = 7;             /* stack: this frame */
    int *heap = malloc(sizeof(int));   /* heap */
    *heap = 9;
    printf("%d %d %s %d %d\\n", counter, table[50], greeting, local, *heap);
    free(heap);
    return 0;
}
`,
    tryThis: [
      "Run the program, open the Memory panel and find `counter`, `table`, `local` and the heap block: note which segment each one is in.",
      "Add `greeting[0] = 'H';` and run: the sandbox reports a write to read-only memory.",
      "Add a second `malloc` and watch the heap grow; remove a `free` and read the leak report at exit.",
    ],
  },
  {
    id: "undefined-behaviour-sandbox",
    title: "What undefined behaviour really does (the memory sandbox)",
    phase: "run",
    summary:
      "C leaves many mistakes undefined; the sandbox checks every memory access so you see the mistake at the line where it happens.",
    body: [
      "The C standard defines what a correct program does and says nothing about what an incorrect one does. Reading past the end of an array, using memory after `free`, dereferencing a null or uninitialised pointer, signed overflow: these are **undefined behaviour** (UB). A real compiler assumes they never happen, and the program that does them may crash, print garbage, work by accident, or be silently optimised into something unrecognisable. UB is not an error the machine reports; it is a contract you broke.",
      "This tool runs your program inside a **memory sandbox** that records the bounds and state of every object: each stack slot, each global, each heap block. Every load and store is checked against that record. When a check fails, the program stops at the exact source line, names the kind of fault, and shows what the pointer actually referred to. It is the behaviour a checker like Valgrind or AddressSanitizer gives you, built into the interpreter.",
      "The example is correct as written. The comments mark two one-line changes that make it incorrect: setting `n` to 5 reads `a[4]`, one past the end, and the sandbox reports an out-of-bounds read at that line; uncommenting the final `printf` reads `*p` after `free(p)`, a use-after-free. Neither would necessarily crash on a real machine, which is exactly why they are dangerous.",
      "The sandbox is also why the three engines in this tool, the tree-walking interpreter, the IR interpreter and the RISC-V simulator, can disagree on a buggy program while agreeing on every correct one. A correct program has exactly one meaning; an incorrect one has none, and each engine will show you a different accident.",
    ],
    example: `#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int a[4] = {1, 2, 3, 4};
    int n = 4;                /* change to 5: the out-of-bounds read is caught */
    int *p = malloc(sizeof(int));
    int i, sum = 0;
    *p = 10;
    for (i = 0; i < n; i++) sum += a[i];
    printf("sum=%d *p=%d\\n", sum, *p);
    free(p);
    /* uncomment the next line: use-after-free, caught at this exact line */
    /* printf("%d\\n", *p); */
    return 0;
}
`,
    tryThis: [
      "Change `n = 4` to `n = 5` and run: read the fault report and the line it points at.",
      "Uncomment the last `printf` and run: the sandbox names the freed block the pointer refers to.",
      "Declare `int q;` and print `q` without assigning it: the uninitialised read is reported too.",
    ],
  },
];

/** Lessons grouped in phase order, for the sidebar. */
export const LESSONS_BY_PHASE: Record<Phase, Lesson[]> = (() => {
  const out = {
    lex: [],
    preprocess: [],
    parse: [],
    sema: [],
    ir: [],
    opt: [],
    codegen: [],
    run: [],
  } as Record<Phase, Lesson[]>;
  for (const l of LESSONS) out[l.phase].push(l);
  return out;
})();

export function findLesson(id: string): Lesson | undefined {
  return LESSONS.find((l) => l.id === id);
}
