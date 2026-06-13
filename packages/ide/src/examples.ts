/** Runnable C teaching programs shown in the IDE and retrieved by the assistant. */
export interface Example {
  name: string;
  category: string;
  description: string;
  files: Record<string, string>;
}

/** Shorthand for a single-file example. */
function one(name: string, category: string, description: string, code: string): Example {
  return { name, category, description, files: { 'main.c': code } };
}

export const EXAMPLES: Example[] = [
  one('Hello, world', 'Basics', 'The classic first program — print a line of text.',
`#include <stdio.h>

int main(void) {
    printf("Hello, world!\\n");
    return 0;
}
`),
  one('Read a number', 'Basics', 'Read an integer from the user with scanf and echo it back.',
`#include <stdio.h>

int main(void) {
    int n;
    printf("Enter a number: ");
    scanf("%d", &n);
    printf("You entered %d, its square is %d\\n", n, n * n);
    return 0;
}
`),
  one('Temperature convert', 'Basics', 'Celsius to Fahrenheit with floating-point arithmetic.',
`#include <stdio.h>

int main(void) {
    double c = 100.0;
    double f = c * 9.0 / 5.0 + 32.0;
    printf("%.1f C = %.1f F\\n", c, f);
    return 0;
}
`),
  one('FizzBuzz', 'Control flow', 'Print 1..20, replacing multiples of 3/5 with Fizz/Buzz.',
`#include <stdio.h>

int main(void) {
    int i;
    for (i = 1; i <= 20; i++) {
        if (i % 15 == 0) printf("FizzBuzz\\n");
        else if (i % 3 == 0) printf("Fizz\\n");
        else if (i % 5 == 0) printf("Buzz\\n");
        else printf("%d\\n", i);
    }
    return 0;
}
`),
  one('Sum 1..N', 'Control flow', 'Add up the first N integers with a for loop.',
`#include <stdio.h>

int main(void) {
    int n = 100, i;
    long sum = 0;
    for (i = 1; i <= n; i++) sum += i;
    printf("sum 1..%d = %ld\\n", n, sum);
    return 0;
}
`),
  one('Multiplication table', 'Control flow', 'Nested loops printing a 2-D grid.',
`#include <stdio.h>

int main(void) {
    int i, j;
    for (i = 1; i <= 5; i++) {
        for (j = 1; j <= 5; j++) printf("%3d", i * j);
        printf("\\n");
    }
    return 0;
}
`),
  one('Prime sieve', 'Algorithms', 'Sieve of Eratosthenes over an array of flags.',
`#include <stdio.h>

int main(void) {
    int is[100], i, j;
    for (i = 0; i < 100; i++) is[i] = 1;
    for (i = 2; i < 100; i++)
        if (is[i])
            for (j = i * i; j < 100; j += i) is[j] = 0;
    for (i = 2; i < 100; i++) if (is[i]) printf("%d ", i);
    printf("\\n");
    return 0;
}
`),
  one('Fibonacci', 'Algorithms', 'The Fibonacci sequence, computed iteratively.',
`#include <stdio.h>

int main(void) {
    int a = 0, b = 1, i;
    for (i = 0; i < 15; i++) {
        printf("%d ", a);
        { int t = a + b; a = b; b = t; }
    }
    printf("\\n");
    return 0;
}
`),
  one('Factorial (recursion)', 'Algorithms', 'A recursive function — watch the call stack grow.',
`#include <stdio.h>

int fact(int n) {
    if (n <= 1) return 1;
    return n * fact(n - 1);
}

int main(void) {
    printf("5! = %d\\n", fact(5));
    return 0;
}
`),
  one('GCD (Euclid)', 'Algorithms', 'Greatest common divisor by the Euclid algorithm.',
`#include <stdio.h>

int gcd(int a, int b) { return b ? gcd(b, a % b) : a; }

int main(void) {
    printf("gcd(48, 36) = %d\\n", gcd(48, 36));
    return 0;
}
`),
  one('Bubble sort', 'Algorithms', 'Sort an array of integers in place.',
`#include <stdio.h>

int main(void) {
    int a[8], i, j, n = 8;
    a[0]=5; a[1]=1; a[2]=4; a[3]=2; a[4]=8; a[5]=0; a[6]=7; a[7]=3;
    for (i = 0; i < n - 1; i++)
        for (j = 0; j < n - 1 - i; j++)
            if (a[j] > a[j + 1]) { int t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; }
    for (i = 0; i < n; i++) printf("%d ", a[i]);
    printf("\\n");
    return 0;
}
`),
  one('qsort', 'Algorithms', 'Sort with the standard library qsort and a comparator.',
`#include <stdio.h>
#include <stdlib.h>

int cmp(const void *a, const void *b) { return *(const int*)a - *(const int*)b; }

int main(void) {
    int a[6] = {9, 3, 7, 1, 8, 2}, i;
    qsort(a, 6, sizeof(int), cmp);
    for (i = 0; i < 6; i++) printf("%d ", a[i]);
    printf("\\n");
    return 0;
}
`),
  one('Pointers & the stack', 'Memory', 'A pointer holds the address of another variable.',
`#include <stdio.h>

int main(void) {
    int a = 10, b = 20;
    int *p = &a;
    *p = 99;                 /* changes a through the pointer */
    printf("a=%d b=%d *p=%d\\n", a, b, *p);
    return 0;
}
`),
  one('Swap with pointers', 'Memory', 'Pass addresses so a function can modify the callers variables.',
`#include <stdio.h>

void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }

int main(void) {
    int x = 3, y = 7;
    swap(&x, &y);
    printf("%d %d\\n", x, y);
    return 0;
}
`),
  one('malloc & the heap', 'Memory', 'Allocate an array on the heap, use it, and free it.',
`#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int n = 5, i;
    int *arr = malloc(n * sizeof(int));
    for (i = 0; i < n; i++) arr[i] = i * i;
    for (i = 0; i < n; i++) printf("%d ", arr[i]);
    printf("\\n");
    free(arr);
    return 0;
}
`),
  one('Use-after-free (bug!)', 'Memory', 'The sandbox catches reading memory after free() — at the exact line.',
`#include <stdlib.h>

int main(void) {
    int *p = malloc(sizeof(int));
    *p = 42;
    free(p);
    return *p;   /* use-after-free */
}
`),
  one('Memory leak (bug!)', 'Memory', 'Allocated but never freed — reported at program exit.',
`#include <stdlib.h>

int main(void) {
    int *a = malloc(64);
    int *b = malloc(32);
    free(a);          /* b is leaked */
    return 0;
}
`),
  one('Array out of bounds (bug!)', 'Memory', 'Writing past the end of an array is caught.',
`int main(void) {
    int a[4];
    int i;
    for (i = 0; i <= 4; i++) a[i] = i;   /* i == 4 is out of bounds */
    return 0;
}
`),
  one('String length', 'Strings', 'Walk a string to its NUL terminator.',
`#include <stdio.h>

int mystrlen(const char *s) { int n = 0; while (*s++) n++; return n; }

int main(void) {
    printf("%d\\n", mystrlen("hello, world"));
    return 0;
}
`),
  one('Reverse a string', 'Strings', 'Swap characters from the ends inward, in place.',
`#include <stdio.h>
#include <string.h>

void rev(char *s) {
    int i, n = strlen(s);
    for (i = 0; i < n / 2; i++) { char t = s[i]; s[i] = s[n-1-i]; s[n-1-i] = t; }
}

int main(void) {
    char s[] = "reverse me";
    rev(s);
    printf("%s\\n", s);
    return 0;
}
`),
  one('Count vowels', 'Strings', 'Classify characters with ctype.h.',
`#include <stdio.h>
#include <ctype.h>

int main(void) {
    const char *s = "The quick brown fox";
    int i, v = 0;
    for (i = 0; s[i]; i++)
        if (strchr("aeiouAEIOU", s[i])) v++;
    printf("%d vowels\\n", v);
    return 0;
}
`),
  one('Struct: points', 'Types', 'Group fields into a record and pass it to a function.',
`#include <stdio.h>

struct Point { int x, y; };

int dist2(struct Point a, struct Point b) {
    int dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy;
}

int main(void) {
    struct Point p, q;
    p.x = 0; p.y = 0; q.x = 3; q.y = 4;
    printf("%d\\n", dist2(p, q));
    return 0;
}
`),
  one('Linked list', 'Types', 'Build a small singly linked list on the heap and sum it.',
`#include <stdio.h>
#include <stdlib.h>

struct Node { int v; struct Node *next; };

int main(void) {
    struct Node *head = NULL;
    int i, sum = 0;
    for (i = 5; i >= 1; i--) {
        struct Node *n = malloc(sizeof(struct Node));
        n->v = i; n->next = head; head = n;
    }
    { struct Node *p; for (p = head; p; p = p->next) sum += p->v; }
    printf("sum = %d\\n", sum);
    return 0;
}
`),
  one('Enums', 'Types', 'Named integer constants for readable code.',
`#include <stdio.h>

enum Day { MON, TUE, WED, THU, FRI, SAT, SUN };

int main(void) {
    enum Day d = WED;
    printf("day index = %d\\n", (int)d);
    return 0;
}
`),
  one('Function pointers', 'Types', 'Store a function in a pointer and call through it.',
`#include <stdio.h>

int add(int a, int b) { return a + b; }
int mul(int a, int b) { return a * b; }

int main(void) {
    int (*ops[2])(int, int) = { add, mul };
    printf("%d %d\\n", ops[0](6, 7), ops[1](6, 7));
    return 0;
}
`),
  one('Write & read a file', 'Files', 'Round-trip data through the virtual filesystem.',
`#include <stdio.h>

int main(void) {
    FILE *f = fopen("notes.txt", "w");
    fprintf(f, "line one\\nline two\\n");
    fclose(f);

    f = fopen("notes.txt", "r");
    { char buf[64]; while (fgets(buf, sizeof(buf), f)) printf("> %s", buf); }
    fclose(f);
    return 0;
}
`),
  one('Preprocessor macros', 'Preprocessor', 'Object- and function-like macros — see the Preprocessor lens.',
`#include <stdio.h>

#define SQUARE(x) ((x) * (x))
#define MAX(a, b) ((a) > (b) ? (a) : (b))

int main(void) {
    printf("%d %d\\n", SQUARE(7), MAX(3, 9));
    return 0;
}
`),
  {
    name: 'Multi-file project',
    category: 'Preprocessor',
    description: 'A header + two .c files, linked together.',
    files: {
      'main.c': `#include <stdio.h>
#include "mathutil.h"

int main(void) {
    printf("%d %d\\n", square(9), cube(3));
    return 0;
}
`,
      'mathutil.h': `#ifndef MATHUTIL_H
#define MATHUTIL_H
int square(int);
int cube(int);
#endif
`,
      'mathutil.c': `#include "mathutil.h"
int square(int n) { return n * n; }
int cube(int n) { return n * n * n; }
`,
    },
  },
];

export const DEFAULT_PROJECT = EXAMPLES[0]!.files;
