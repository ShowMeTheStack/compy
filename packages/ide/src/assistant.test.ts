import { describe, it, expect } from 'vitest';
import { respond } from './assistant';

describe('offline C assistant', () => {
  it('greets and offers help', () => {
    expect(respond('hi')).toMatch(/C helper/i);
  });

  it('explains loops with a code fence', () => {
    const r = respond('how do I write a loop?');
    expect(r).toMatch(/for/i);
    expect(r).toContain('```c');
  });

  it('explains pointers', () => {
    expect(respond('how do pointers work')).toMatch(/address/i);
  });

  it('explains malloc and mentions leaks', () => {
    const r = respond('how do I use malloc');
    expect(r).toMatch(/heap/i);
    expect(r).toMatch(/free/i);
  });

  it('explains a memory fault when pasted', () => {
    expect(respond('I got a use-after-free error')).toMatch(/use-after-free/i);
    expect(respond('segmentation fault')).toMatch(/NULL|address 0/i);
  });

  it('retrieves an example program for a build request', () => {
    const r = respond('write a program to sort numbers');
    expect(r).toContain('```c');
    expect(r).toMatch(/sort|qsort|bubble/i);
  });

  it('follow-up "another" returns a different program', () => {
    const first = respond('write a program to sort numbers');
    const history = [
      { role: 'user' as const, text: 'write a program to sort numbers' },
      { role: 'assistant' as const, text: first },
    ];
    const second = respond('another', history);
    expect(second).toContain('```c');
  });

  it('has a graceful fallback', () => {
    expect(respond('asdkjfh qwoieu')).toMatch(/not sure|rephrasing|write a program/i);
  });
});
