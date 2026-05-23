/**
 * The C89 standard library headers, served as virtual files under
 * /usr/include so `#include <stdio.h>` resolves through the preprocessor's
 * file resolver. They supply the typedefs (size_t, FILE, ...), macros (NULL,
 * EOF, stdin/stdout/stderr, assert, ...), and prototypes real programs need;
 * the functions themselves are provided as native implementations resolved by
 * name. stdin/stdout/stderr expand to __iob(fd), a native returning the FILE*.
 */

const COMMON_SIZE_T = `#ifndef _SIZE_T_DEFINED
#define _SIZE_T_DEFINED
typedef unsigned long size_t;
#endif
`;

const STDDEF = `#ifndef _STDDEF_H
#define _STDDEF_H
${COMMON_SIZE_T}#ifndef NULL
#define NULL ((void*)0)
#endif
typedef long ptrdiff_t;
#define offsetof(type, member) ((size_t)&(((type*)0)->member))
#endif
`;

const STDIO = `#ifndef _STDIO_H
#define _STDIO_H
${COMMON_SIZE_T}#ifndef NULL
#define NULL ((void*)0)
#endif
typedef struct __sFILE FILE;
#define EOF (-1)
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
#define BUFSIZ 1024
#define FILENAME_MAX 260
FILE *__iob(int __fd);
#define stdin  __iob(0)
#define stdout __iob(1)
#define stderr __iob(2)
int printf(const char *, ...);
int fprintf(FILE *, const char *, ...);
int sprintf(char *, const char *, ...);
int snprintf(char *, size_t, const char *, ...);
int scanf(const char *, ...);
int fscanf(FILE *, const char *, ...);
int sscanf(const char *, const char *, ...);
int putchar(int);
int getchar(void);
int puts(const char *);
int fputs(const char *, FILE *);
int fputc(int, FILE *);
int putc(int, FILE *);
int fgetc(FILE *);
int getc(FILE *);
char *fgets(char *, int, FILE *);
int ungetc(int, FILE *);
FILE *fopen(const char *, const char *);
int fclose(FILE *);
size_t fread(void *, size_t, size_t, FILE *);
size_t fwrite(const void *, size_t, size_t, FILE *);
int fseek(FILE *, long, int);
long ftell(FILE *);
void rewind(FILE *);
int feof(FILE *);
int ferror(FILE *);
void clearerr(FILE *);
int fflush(FILE *);
int remove(const char *);
int rename(const char *, const char *);
void perror(const char *);
#endif
`;

const STDLIB = `#ifndef _STDLIB_H
#define _STDLIB_H
${COMMON_SIZE_T}#ifndef NULL
#define NULL ((void*)0)
#endif
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#define RAND_MAX 2147483647
typedef struct { int quot; int rem; } div_t;
typedef struct { long quot; long rem; } ldiv_t;
void *malloc(size_t);
void *calloc(size_t, size_t);
void *realloc(void *, size_t);
void free(void *);
void exit(int);
void abort(void);
int atexit(void (*)(void));
int atoi(const char *);
long atol(const char *);
double atof(const char *);
long strtol(const char *, char **, int);
unsigned long strtoul(const char *, char **, int);
double strtod(const char *, char **);
int abs(int);
long labs(long);
div_t div(int, int);
ldiv_t ldiv(long, long);
int rand(void);
void srand(unsigned);
void qsort(void *, size_t, size_t, int (*)(const void *, const void *));
void *bsearch(const void *, const void *, size_t, size_t, int (*)(const void *, const void *));
char *getenv(const char *);
int system(const char *);
#endif
`;

const STRING = `#ifndef _STRING_H
#define _STRING_H
${COMMON_SIZE_T}#ifndef NULL
#define NULL ((void*)0)
#endif
size_t strlen(const char *);
char *strcpy(char *, const char *);
char *strncpy(char *, const char *, size_t);
char *strcat(char *, const char *);
char *strncat(char *, const char *, size_t);
int strcmp(const char *, const char *);
int strncmp(const char *, const char *, size_t);
char *strchr(const char *, int);
char *strrchr(const char *, int);
char *strstr(const char *, const char *);
char *strpbrk(const char *, const char *);
size_t strspn(const char *, const char *);
size_t strcspn(const char *, const char *);
char *strtok(char *, const char *);
char *strdup(const char *);
void *memcpy(void *, const void *, size_t);
void *memmove(void *, const void *, size_t);
void *memset(void *, int, size_t);
int memcmp(const void *, const void *, size_t);
void *memchr(const void *, int, size_t);
char *strerror(int);
#endif
`;

const MATH = `#ifndef _MATH_H
#define _MATH_H
#define M_PI 3.14159265358979323846
#define M_E 2.71828182845904523536
#define HUGE_VAL (1e308*10)
double sqrt(double);
double pow(double, double);
double fabs(double);
double floor(double);
double ceil(double);
double round(double);
double sin(double);
double cos(double);
double tan(double);
double asin(double);
double acos(double);
double atan(double);
double atan2(double, double);
double exp(double);
double log(double);
double log10(double);
double fmod(double, double);
double sinh(double);
double cosh(double);
double tanh(double);
double ldexp(double, int);
double frexp(double, int *);
double modf(double, double *);
#endif
`;

const CTYPE = `#ifndef _CTYPE_H
#define _CTYPE_H
int isalpha(int);
int isdigit(int);
int isalnum(int);
int isspace(int);
int isupper(int);
int islower(int);
int ispunct(int);
int isprint(int);
int isgraph(int);
int iscntrl(int);
int isxdigit(int);
int toupper(int);
int tolower(int);
#endif
`;

const STDBOOL = `#ifndef _STDBOOL_H
#define _STDBOOL_H
#define bool _Bool
#define true 1
#define false 0
#define __bool_true_false_are_defined 1
#endif
`;

const ASSERT = `#ifndef _ASSERT_H
#define _ASSERT_H
void __assert_fail(const char *, const char *, int);
#ifdef NDEBUG
#define assert(e) ((void)0)
#else
#define assert(e) ((e) ? (void)0 : __assert_fail(#e, __FILE__, __LINE__))
#endif
#endif
`;

const ERRNO = `#ifndef _ERRNO_H
#define _ERRNO_H
int *__errno_location(void);
#define errno (*__errno_location())
#define EPERM 1
#define ENOENT 2
#define EBADF 9
#define EACCES 13
#define EEXIST 17
#define EINVAL 22
#define ERANGE 34
#endif
`;

const LIMITS = `#ifndef _LIMITS_H
#define _LIMITS_H
#define CHAR_BIT 8
#define SCHAR_MIN (-128)
#define SCHAR_MAX 127
#define UCHAR_MAX 255
#define CHAR_MIN (-128)
#define CHAR_MAX 127
#define SHRT_MIN (-32768)
#define SHRT_MAX 32767
#define USHRT_MAX 65535
#define INT_MIN (-2147483647 - 1)
#define INT_MAX 2147483647
#define UINT_MAX 4294967295U
#define LONG_MIN (-2147483647L - 1)
#define LONG_MAX 2147483647L
#define ULONG_MAX 4294967295UL
#endif
`;

const FLOATH = `#ifndef _FLOAT_H
#define _FLOAT_H
#define FLT_MAX 3.40282347e+38F
#define FLT_MIN 1.17549435e-38F
#define FLT_EPSILON 1.19209290e-7F
#define DBL_MAX 1.7976931348623157e+308
#define DBL_MIN 2.2250738585072014e-308
#define DBL_EPSILON 2.2204460492503131e-16
#define FLT_DIG 6
#define DBL_DIG 15
#endif
`;

const TIME = `#ifndef _TIME_H
#define _TIME_H
${COMMON_SIZE_T}typedef long time_t;
typedef long clock_t;
#define CLOCKS_PER_SEC 1000000
struct tm { int tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year, tm_wday, tm_yday, tm_isdst; };
time_t time(time_t *);
clock_t clock(void);
double difftime(time_t, time_t);
char *ctime(const time_t *);
struct tm *localtime(const time_t *);
struct tm *gmtime(const time_t *);
time_t mktime(struct tm *);
size_t strftime(char *, size_t, const char *, const struct tm *);
#endif
`;

const STDARG = `#ifndef _STDARG_H
#define _STDARG_H
typedef char *va_list;
#define va_start(ap, last) __va_start(&(ap), last)
#define va_arg(ap, type) (*(type *)__va_arg(&(ap), sizeof(type)))
#define va_end(ap) ((void)0)
void __va_start(va_list *, ...);
void *__va_arg(va_list *, unsigned long);
#endif
`;

export function standardHeaders(): Record<string, string> {
  return {
    '/usr/include/stddef.h': STDDEF,
    '/usr/include/stdio.h': STDIO,
    '/usr/include/stdlib.h': STDLIB,
    '/usr/include/string.h': STRING,
    '/usr/include/math.h': MATH,
    '/usr/include/ctype.h': CTYPE,
    '/usr/include/stdbool.h': STDBOOL,
    '/usr/include/assert.h': ASSERT,
    '/usr/include/errno.h': ERRNO,
    '/usr/include/limits.h': LIMITS,
    '/usr/include/float.h': FLOATH,
    '/usr/include/time.h': TIME,
    '/usr/include/stdarg.h': STDARG,
  };
}

export const SYSTEM_INCLUDE_DIRS = ['/usr/include'];
