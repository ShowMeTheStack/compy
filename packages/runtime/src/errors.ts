/**
 * Memory faults — the events the "valgrind-for-beginners" sandbox reports. In
 * real C these are silent corruption or a crash; here every one is caught with
 * the exact address and a plain-English explanation a student can learn from.
 */
export type FaultKind =
  | 'null-deref' // read/write through a NULL (or near-NULL) pointer
  | 'segfault' // access to an unmapped address
  | 'out-of-bounds' // access past the end (or before the start) of an object
  | 'uninitialized-read' // reading memory that was never written
  | 'use-after-free' // access to a heap block that was freed
  | 'double-free' // free() of an already-freed block
  | 'invalid-free' // free() of something that isn't a heap allocation
  | 'write-to-readonly' // writing string literals / const / code
  | 'stack-overflow' // recursion / locals exceeded the stack
  | 'leak'; // heap block never freed (reported at exit)

/** Human-friendly one-liners; the IDE expands these with the address + line. */
export const FAULT_HELP: Record<FaultKind, string> = {
  'null-deref': 'Dereferenced a NULL pointer — it points to address 0, which no object lives at.',
  segfault: 'Accessed an address that is not part of any variable, array, or allocation.',
  'out-of-bounds': 'Read or wrote past the end (or before the start) of an object.',
  'uninitialized-read': 'Read a variable/allocation before giving it a value — its contents are garbage.',
  'use-after-free': 'Used memory through a pointer after free() released it (a dangling pointer).',
  'double-free': 'Called free() twice on the same block.',
  'invalid-free': 'Called free() on a pointer that was not returned by malloc/calloc/realloc.',
  'write-to-readonly': 'Wrote to read-only memory (a string literal, const, or the code segment).',
  'stack-overflow': 'The call stack ran out of room — usually runaway recursion or a huge local array.',
  leak: 'Allocated memory with malloc/calloc/realloc that was never freed.',
};

export class CFault extends Error {
  constructor(
    readonly kind: FaultKind,
    readonly addr: number,
    /** How many bytes the faulting access touched. */
    readonly size: number = 0,
    detail?: string,
  ) {
    super(detail ?? FAULT_HELP[kind]);
    this.name = 'CFault';
  }
}
