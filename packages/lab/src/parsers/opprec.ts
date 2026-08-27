import { Grammar, PrecDecl, isTerminal, END } from '../grammar';
import { LabToken } from '../lexer';
import { ParseResult, TraceBuilder, Conflict } from '../trace';

/**
 * Operator-precedence parsing by precedence climbing, driven by the
 * grammar's %left / %right / %nonassoc declarations. Operands are any
 * terminal not declared as an operator; '(' ')' group. Visualized both as
 * the recursive calls (with their minimum precedence) and as the operand /
 * operator stacks of the equivalent shunting-yard machine.
 */
export interface OpTable {
  ops: { symbol: string; level: number; assoc: PrecDecl['assoc'] }[];
  operands: string[];
}

export function buildOpTable(g: Grammar): OpTable {
  const ops: OpTable['ops'] = [];
  for (const d of g.precedence) for (const s of d.symbols) ops.push({ symbol: s, level: d.level, assoc: d.assoc });
  const operands = g.terminals.filter((t) => !ops.some((o) => o.symbol === t) && t !== '(' && t !== ')');
  return { ops, operands };
}

export function opprecParse(g: Grammar, tokens: LabToken[]): ParseResult {
  const table = buildOpTable(g);
  const tb = new TraceBuilder();
  const conflicts: Conflict[] = [];
  if (table.ops.length === 0) conflicts.push({ kind: 'choice', where: 'grammar', message: 'no %left / %right / %nonassoc declarations: the operator-precedence parser needs them' });
  const inp = [...tokens.map((t) => t.name), END];
  let pos = 0;
  const callStack: string[] = [];
  const operandStack: string[] = [];
  const operatorStack: string[] = [];
  let error: ParseResult['error'] | undefined;
  const snap = () => ({ callStack: callStack.slice(), stack: [`operands: ${operandStack.join(' ') || '∅'}`, `operators: ${operatorStack.join(' ') || '∅'}`] });
  const opOf = (s: string) => table.ops.find((o) => o.symbol === s);
  const fail = (message: string, expected: string[]) => {
    error = { pos, message, expected };
    tb.step({ action: 'error', detail: message, pos, ...snap(), error });
  };
  const primary = (): number | null => {
    const t = inp[pos]!;
    if (t === '(') {
      const tok = tokens[pos]!;
      pos++;
      operatorStack.push('(');
      tb.step({ action: 'open', detail: `'(' starts a nested expression`, pos, ...snap() });
      const inner = expr(0);
      if (error) return null;
      if (inp[pos] !== ')') {
        fail(`expected ')' at token ${pos + 1}`, [')']);
        return null;
      }
      const close = tokens[pos]!;
      pos++;
      operatorStack.pop();
      tb.step({ action: 'close', detail: `')' closes the nested expression`, pos, ...snap() });
      const node = tb.node('group', false);
      tb.attach(node, tb.node('(', true, tok));
      if (inner !== null) tb.attach(node, inner);
      tb.attach(node, tb.node(')', true, close));
      return node;
    }
    if (t !== END && !opOf(t) && t !== ')') {
      const tok = tokens[pos]!;
      pos++;
      operandStack.push(tok.text);
      tb.step({ action: 'operand', detail: `operand ${t} "${tok.text}"`, pos, ...snap() });
      return tb.node(t, true, tok);
    }
    const tok = tokens[pos];
    fail(tok ? `expected an operand but found ${tok.name} "${tok.text}" at token ${pos + 1}` : 'expected an operand but reached the end of input', table.operands);
    return null;
  };
  const expr = (minPrec: number): number | null => {
    callStack.push(`expr(min=${minPrec})`);
    tb.step({ action: 'call', detail: `expr(min precedence ${minPrec})`, pos, ...snap() });
    let left = primary();
    if (error) {
      callStack.pop();
      return null;
    }
    for (;;) {
      const t = inp[pos]!;
      const op = opOf(t);
      if (!op || op.level < minPrec) {
        tb.step({ action: 'return', detail: op ? `${t} (level ${op.level}) binds looser than ${minPrec}: return` : `no operator next (${t}): return`, pos, ...snap() });
        break;
      }
      if (op.assoc === 'nonassoc' && operatorStack.includes(t) && operatorStack[operatorStack.length - 1] === t) {
        fail(`${t} is non-associative: "a ${t} b ${t} c" is not allowed`, []);
        callStack.pop();
        return null;
      }
      const tok = tokens[pos]!;
      pos++;
      operatorStack.push(t);
      const nextMin = op.assoc === 'right' ? op.level : op.level + 1;
      tb.step({ action: 'operator', detail: `operator ${t} (level ${op.level}, ${op.assoc}); parse right side with min ${nextMin}`, pos, ...snap() });
      const right = expr(nextMin);
      if (error) {
        callStack.pop();
        return null;
      }
      operatorStack.pop();
      // Combine.
      const r = operandStack.pop() ?? '?';
      const l = operandStack.pop() ?? '?';
      operandStack.push(`(${l} ${t} ${r})`);
      const node = tb.node(t, false);
      if (left !== null) tb.attach(node, left);
      tb.attach(node, tb.node(t, true, tok));
      if (right !== null) tb.attach(node, right);
      tb.step({ action: 'combine', detail: `build ${l} ${t} ${r}`, pos, ...snap() });
      left = node;
    }
    callStack.pop();
    return left;
  };
  const root = expr(0);
  let accepted = false;
  if (!error) {
    if (inp[pos] === END) {
      accepted = true;
      tb.step({ action: 'accept', detail: 'accepted', pos, ...snap() });
    } else {
      const tok = tokens[pos]!;
      fail(`trailing input: ${tok.name} "${tok.text}" at token ${pos + 1}`, [END]);
    }
  }
  return { parser: 'opprec', steps: tb.steps, accepted, treeOps: tb.treeOps, roots: root === null ? [] : [root], conflicts, error, extra: table };
}

export { isTerminal };
