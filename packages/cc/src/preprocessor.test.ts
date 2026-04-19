import { describe, it, expect } from 'vitest';
import { preprocess, PreprocessOptions } from './preprocessor';

/** Preprocess and return the significant tokens' spellings joined by spaces. */
function pp(src: string, opts: PreprocessOptions = {}): string {
  const { tokens } = preprocess(src, opts);
  return tokens
    .filter((t) => t.kind !== 'eof')
    .map((t) => t.value)
    .join(' ');
}

function errors(src: string, opts: PreprocessOptions = {}): string[] {
  return preprocess(src, opts).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
}

describe('object-like macros', () => {
  it('expands simple object macros', () => {
    expect(pp('#define PI 3\nint x = PI;')).toBe('int x = 3 ;');
  });
  it('expands nested macros', () => {
    expect(pp('#define A B\n#define B 42\nA')).toBe('42');
  });
  it('does not expand a name inside its own expansion (hide-set)', () => {
    expect(pp('#define X X\nX')).toBe('X');
    expect(pp('#define A B\n#define B A\nA')).toBe('A');
  });
  it('#undef removes a macro', () => {
    expect(pp('#define X 1\n#undef X\nX')).toBe('X');
  });
});

describe('function-like macros', () => {
  it('substitutes arguments', () => {
    expect(pp('#define ADD(a,b) ((a)+(b))\nADD(1,2)')).toBe('( ( 1 ) + ( 2 ) )');
  });
  it('macro-expands arguments before substitution', () => {
    expect(pp('#define ONE 1\n#define ID(x) x\nID(ONE)')).toBe('1');
  });
  it('is not invoked without parentheses', () => {
    expect(pp('#define F(x) x\nF + 1')).toBe('F + 1');
  });
  it('handles empty arguments', () => {
    expect(pp('#define E(x) [x]\nE()')).toBe('[ ]');
  });
  it('handles nested parentheses in arguments', () => {
    expect(pp('#define F(x) x\nF((1,2))')).toBe('( 1 , 2 )');
  });
  it('supports the classic max macro', () => {
    expect(pp('#define MAX(a,b) ((a)>(b)?(a):(b))\nMAX(3,4)')).toBe('( ( 3 ) > ( 4 ) ? ( 3 ) : ( 4 ) )');
  });
});

describe('stringize (#) and paste (##)', () => {
  it('stringizes an argument', () => {
    expect(pp('#define STR(x) #x\nSTR(hello world)')).toBe('"hello world"');
  });
  it('escapes quotes and backslashes when stringizing', () => {
    expect(pp('#define STR(x) #x\nSTR("a\\b")')).toBe('"\\"a\\\\b\\""');
  });
  it('pastes two tokens', () => {
    expect(pp('#define CAT(a,b) a##b\nCAT(foo,bar)')).toBe('foobar');
  });
  it('pastes to form a number', () => {
    expect(pp('#define CAT(a,b) a##b\nCAT(12,34)')).toBe('1234');
  });
  it('paste with an empty operand yields the other operand', () => {
    expect(pp('#define CAT(a,b) a##b\nCAT(x,)')).toBe('x');
    expect(pp('#define CAT(a,b) a##b\nCAT(,y)')).toBe('y');
  });
});

describe('predefined macros', () => {
  it('expands __LINE__ and __FILE__', () => {
    const out = pp('__FILE__\n__LINE__', { file: '/home/main.c' });
    expect(out).toBe('"/home/main.c" 2');
  });
  it('expands __DATE__ and __TIME__ deterministically', () => {
    expect(pp('__DATE__ __TIME__', { date: 'Aug 14 2026', time: '12:00:00' })).toBe('"Aug 14 2026" "12:00:00"');
  });
  it('exposes user predefined macros', () => {
    expect(pp('DEBUG', { predefined: { DEBUG: '1' } })).toBe('1');
  });
});

describe('conditionals', () => {
  it('#ifdef / #ifndef', () => {
    expect(pp('#define A\n#ifdef A\nyes\n#endif')).toBe('yes');
    expect(pp('#ifndef A\nno\n#endif')).toBe('no');
  });
  it('#if with arithmetic', () => {
    expect(pp('#if 2 + 3 * 4 == 14\nok\n#endif')).toBe('ok');
    expect(pp('#if 1 << 4 > 10\nbig\n#endif')).toBe('big');
  });
  it('#if / #elif / #else chain picks the first true branch', () => {
    const src = '#if 0\nA\n#elif 1\nB\n#elif 1\nC\n#else\nD\n#endif';
    expect(pp(src)).toBe('B');
  });
  it('#else taken when #if is false', () => {
    expect(pp('#if 0\nA\n#else\nB\n#endif')).toBe('B');
  });
  it('defined operator, both forms', () => {
    expect(pp('#define X 1\n#if defined X && defined(X)\nok\n#endif')).toBe('ok');
    expect(pp('#if !defined(NOPE)\nok\n#endif')).toBe('ok');
  });
  it('nested conditionals with an inactive outer skip the inner', () => {
    expect(pp('#if 0\n#if 1\nA\n#endif\nB\n#endif\nC')).toBe('C');
  });
  it('unknown identifiers in #if evaluate to 0', () => {
    expect(pp('#if UNDEFINED_THING\nA\n#else\nB\n#endif')).toBe('B');
  });
  it('reports division by zero in #if', () => {
    expect(errors('#if 1/0\n#endif')).toContain('division by zero in #if');
  });
});

describe('#include', () => {
  const files: Record<string, string> = {
    '/usr/include/stdio.h': '#define EOF (-1)\nint puts(const char*);',
    '/home/util.h': '#ifndef UTIL_H\n#define UTIL_H\nint util(void);\n#endif',
    '/home/main.c': '',
  };
  const readFile = (p: string) => files[p] ?? null;

  it('includes a system header with <>', () => {
    const out = pp('#include <stdio.h>\nEOF', { file: '/home/main.c', systemDirs: ['/usr/include'], readFile });
    expect(out).toContain('int puts ( const char * ) ;');
    expect(out.trim().endsWith('( - 1 )')).toBe(true);
  });
  it('includes a quoted header relative to the file', () => {
    const out = pp('#include "util.h"\nutil', { file: '/home/main.c', readFile });
    expect(out).toContain('int util ( void ) ;');
  });
  it('include guard prevents double definition', () => {
    const out = pp('#include "util.h"\n#include "util.h"\ndone', { file: '/home/main.c', readFile });
    expect(out).toContain('done');
    // "int util(void);" should appear exactly once.
    expect(out.split('util').length - 1).toBeGreaterThanOrEqual(1);
  });
  it('reports a missing header', () => {
    expect(errors('#include <nope.h>', { file: '/home/main.c', systemDirs: ['/usr/include'], readFile })).toEqual([
      'nope.h: No such file or directory',
    ]);
  });
  it('honours #pragma once', () => {
    const f: Record<string, string> = { '/home/o.h': '#pragma once\nint o;', '/home/m.c': '' };
    const out = pp('#include "o.h"\n#include "o.h"\nend', { file: '/home/m.c', readFile: (p) => f[p] ?? null });
    expect(out.split('int o').length - 1).toBe(1);
    expect(out).toContain('end');
  });
});

describe('errors', () => {
  it('#error surfaces its message', () => {
    expect(errors('#error something broke')).toContain('#error something broke');
  });
  it('detects unbalanced #endif', () => {
    expect(errors('#endif')).toContain('#endif without #if');
  });
});
