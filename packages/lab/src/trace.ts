import type { LabToken } from './lexer';

/**
 * One trace format for every parser, so the Parse and Tree panels and the
 * stepper are shared. Tree construction is recorded as a list of operations
 * replayed up to each step, which makes stepping backwards free.
 */

export type TreeOp = { op: 'node'; id: number; label: string; token?: LabToken; terminal: boolean } | { op: 'attach'; parent: number; child: number } | { op: 'detach'; id: number };

export interface Conflict {
  kind: 'shift/reduce' | 'reduce/reduce' | 'predict' | 'choice';
  where: string;
  message: string;
  state?: number;
  symbol?: string;
}

export interface ParseStep {
  index: number;
  action: string;
  detail: string;
  /** Token index in the input the parser is looking at. */
  pos: number;
  stack?: string[];
  callStack?: string[];
  sententialForm?: string[];
  focus?: {
    table?: [string, string];
    itemSet?: number;
    column?: number;
    cell?: [number, number];
    production?: number;
    line?: number;
  };
  treeOpsUpTo: number;
  error?: { pos: number; message: string; expected: string[] };
}

export interface ParseResult {
  parser: string;
  steps: ParseStep[];
  accepted: boolean;
  treeOps: TreeOp[];
  roots: number[];
  conflicts: Conflict[];
  /** Earley: number of distinct parses (capped). */
  parses?: number;
  error?: { pos: number; message: string; expected: string[] };
  /** Parser-specific tables/structures for the panel. */
  extra?: unknown;
}

export class TraceBuilder {
  readonly steps: ParseStep[] = [];
  readonly treeOps: TreeOp[] = [];
  private nextNode = 0;
  constructor(readonly maxSteps = 20000) {}

  node(label: string, terminal: boolean, token?: LabToken): number {
    const id = this.nextNode++;
    this.treeOps.push({ op: 'node', id, label, token, terminal });
    return id;
  }
  attach(parent: number, child: number): void {
    this.treeOps.push({ op: 'attach', parent, child });
  }
  detach(id: number): void {
    this.treeOps.push({ op: 'detach', id });
  }
  step(s: Omit<ParseStep, 'index' | 'treeOpsUpTo'>): void {
    if (this.steps.length >= this.maxSteps) return;
    this.steps.push({ index: this.steps.length, treeOpsUpTo: this.treeOps.length, ...s });
  }
  get truncated(): boolean {
    return this.steps.length >= this.maxSteps;
  }
}

export interface TreeNode {
  id: number;
  label: string;
  terminal: boolean;
  token?: LabToken;
  children: number[];
  parent: number | null;
}

/** Replay tree ops up to `upTo`, returning nodes and the current roots. */
export function buildTree(ops: TreeOp[], upTo = ops.length): { nodes: Map<number, TreeNode>; roots: number[] } {
  const nodes = new Map<number, TreeNode>();
  for (let k = 0; k < Math.min(upTo, ops.length); k++) {
    const o = ops[k]!;
    if (o.op === 'node') nodes.set(o.id, { id: o.id, label: o.label, terminal: o.terminal, token: o.token, children: [], parent: null });
    else if (o.op === 'attach') {
      const p = nodes.get(o.parent);
      const c = nodes.get(o.child);
      if (p && c) {
        p.children.push(o.child);
        c.parent = o.parent;
      }
    } else {
      const n = nodes.get(o.id);
      if (n) {
        if (n.parent !== null) {
          const p = nodes.get(n.parent);
          if (p) p.children = p.children.filter((x) => x !== o.id);
        }
        const drop = (id: number) => {
          const x = nodes.get(id);
          if (!x) return;
          for (const c of x.children) drop(c);
          nodes.delete(id);
        };
        drop(o.id);
      }
    }
  }
  const roots = [...nodes.values()].filter((n) => n.parent === null).map((n) => n.id);
  return { nodes, roots };
}

/** Bracketed text form of a tree: A(B(x) C(y)). */
export function fmtTree(nodes: Map<number, TreeNode>, id: number): string {
  const n = nodes.get(id);
  if (!n) return '';
  if (n.terminal) return n.token ? n.token.text : n.label;
  if (n.children.length === 0) return `${n.label}(ε)`;
  return `${n.label}(${n.children.map((c) => fmtTree(nodes, c)).join(' ')})`;
}
