import { describe, it, expect } from 'vitest';
import { lex } from './lexer';

function kinds(src: string) {
  return lex(src).tokens.filter((t) => t.kind !== 'eof').map((t) => `${t.kind}:${t.value}`);
}

function values(src: string) {
  return lex(src).tokens.filter((t) => t.kind !== 'eof').map((t) => t.value);
}

describe('identifiers & keywords', () => {
  it('lexes identifiers as id (keywords classified later)', () => {
    expect(kinds('int main foo_bar _x1')).toEqual(['id:int', 'id:main', 'id:foo_bar', 'id:_x1']);
  });
});

describe('numbers', () => {
  it('lexes integer forms', () => {
    expect(values('0 42 0x1F 0755 100u 200L 300ULL')).toEqual(['0', '42', '0x1F', '0755', '100u', '200L', '300ULL']);
  });
  it('lexes floating forms', () => {
    expect(values('3.14 .5 1e10 2.5f 1.0E-3 0x1.8p3')).toEqual(['3.14', '.5', '1e10', '2.5f', '1.0E-3', '0x1.8p3']);
  });
  it('distinguishes member access from a float', () => {
    expect(kinds('p.x')).toEqual(['id:p', 'punct:.', 'id:x']);
    expect(kinds('1.5')).toEqual(['ppnum:1.5']);
  });
});

describe('strings & chars', () => {
  it('lexes string and char literals with escapes', () => {
    expect(kinds('"hi\\n" \'a\' \'\\0\' "with \\" quote"')).toEqual([
      'string:"hi\\n"',
      "char:'a'",
      "char:'\\0'",
      'string:"with \\" quote"',
    ]);
  });
  it('lexes wide-literal prefixes', () => {
    expect(kinds('L"wide" L\'w\'')).toEqual(['string:L"wide"', "char:L'w'"]);
  });
});

describe('punctuators (maximal munch)', () => {
  it('prefers the longest operator', () => {
    expect(values('a>>=b')).toEqual(['a', '>>=', 'b']);
    expect(values('x->y')).toEqual(['x', '->', 'y']);
    expect(values('a...b')).toEqual(['a', '...', 'b']);
    expect(values('i++ +j')).toEqual(['i', '++', '+', 'j']);
  });
  it('lexes ## and #', () => {
    expect(values('#define ## #')).toEqual(['#', 'define', '##', '#']);
  });
});

describe('comments & line splicing', () => {
  it('strips block and line comments', () => {
    expect(values('a /* x */ b // y\nc')).toEqual(['a', 'b', 'c']);
  });
  it('warns on // comments (non-C89)', () => {
    const d = lex('a // note\n').diagnostics;
    expect(d.some((x) => x.code === 'ext/line-comment')).toBe(true);
  });
  it('splices backslash-newline continuations', () => {
    expect(values('ab\\\ncd')).toEqual(['abcd']);
    expect(values('"a\\\nb"')).toEqual(['"ab"']);
  });
  it('keeps line numbers accurate across splices', () => {
    const t = lex('x\\\ny\nz').tokens;
    // x and y are spliced onto line 1; z is on line 3.
    expect(t[0]!.value).toBe('xy');
    expect(t[0]!.span.start.line).toBe(1);
    expect(t[1]!.value).toBe('z');
    expect(t[1]!.span.start.line).toBe(3);
  });
});

describe('token flags', () => {
  it('marks beginning-of-line and space-before', () => {
    const t = lex('#define X\n  Y').tokens;
    expect(t[0]!.atBol).toBe(true); // #
    expect(t[0]!.value).toBe('#');
    const y = t.find((x) => x.value === 'Y')!;
    expect(y.atBol).toBe(true);
    expect(y.spaceBefore).toBe(true);
  });
});

describe('positions', () => {
  it('reports 1-based line/col', () => {
    const t = lex('int\n  x').tokens;
    expect(t[0]!.span.start).toMatchObject({ line: 1, col: 1 });
    expect(t[1]!.span.start).toMatchObject({ line: 2, col: 3 });
  });
});
