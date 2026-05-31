/** Starter C programs shown in the IDE. Each is a complete, runnable project. */
export interface Example {
  name: string;
  files: Record<string, string>;
}

export const EXAMPLES: Example[] = [
  {
    name: 'Hello, world',
    files: {
      'main.c': `#include <stdio.h>

int main(void) {
    printf("Hello, world!\\n");
    return 0;
}
`,
    },
  },
  {
    name: 'Pointers & the stack',
    files: {
      'main.c': `#include <stdio.h>

/* Watch the memory panel: a, b, and p all live on the stack.
   p holds the ADDRESS of a — click "Run" then inspect it. */
int main(void) {
    int a = 10;
    int b = 20;
    int *p = &a;

    *p = 99;          /* changes a through the pointer */
    printf("a=%d b=%d *p=%d\\n", a, b, *p);
    return 0;
}
`,
    },
  },
  {
    name: 'malloc & the heap',
    files: {
      'main.c': `#include <stdio.h>
#include <stdlib.h>

/* The heap panel shows each block. Forget the free() and the
   sandbox reports a leak; free() twice and it catches a double-free. */
int main(void) {
    int n = 5, i;
    int *arr = malloc(n * sizeof(int));
    for (i = 0; i < n; i++) arr[i] = i * i;
    for (i = 0; i < n; i++) printf("%d ", arr[i]);
    printf("\\n");
    free(arr);
    return 0;
}
`,
    },
  },
  {
    name: 'Use-after-free (bug!)',
    files: {
      'main.c': `#include <stdlib.h>

/* The valgrind-for-beginners sandbox catches this at the exact line. */
int main(void) {
    int *p = malloc(sizeof(int));
    *p = 42;
    free(p);
    return *p;   /* use-after-free — reading freed memory */
}
`,
    },
  },
  {
    name: 'Structs & recursion',
    files: {
      'main.c': `#include <stdio.h>

struct Point { int x, y; };

int gcd(int a, int b) { return b ? gcd(b, a % b) : a; }

int main(void) {
    struct Point p = { 12, 18 };
    printf("gcd(%d, %d) = %d\\n", p.x, p.y, gcd(p.x, p.y));
    return 0;
}
`,
    },
  },
  {
    name: 'Preprocessor macros',
    files: {
      'main.c': `#include <stdio.h>

#define SQUARE(x) ((x) * (x))
#define MAX(a, b) ((a) > (b) ? (a) : (b))

int main(void) {
    printf("%d %d\\n", SQUARE(7), MAX(3, 9));
    return 0;
}
`,
    },
  },
];

export const DEFAULT_PROJECT = EXAMPLES[0]!.files;
