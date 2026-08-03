import { useState } from 'react';
import * as A from '@compy/cc';
import { SemaResult, formatType } from '@compy/cc';
import { EditorRange } from './Editor';

/**
 * Phase 7 panel: the abstract syntax tree, as a collapsible outline. Every
 * node links back to its source span; with "show types" on, expression
 * nodes carry the type semantic analysis assigned to them.
 */
interface Props {
  unit: A.TranslationUnit;
  sema: SemaResult;
  activePath: string;
  onHover: (r: EditorRange | null) => void;
  onSelect: (r: EditorRange) => void;
}

interface NodeLike {
  kind?: string;
  span?: A.Span;
}

function rangeOf(span: A.Span): EditorRange {
  return { line: span.start.line, col: span.start.col, endLine: span.end.line, endCol: span.end.col };
}

/** A compact label for a node: kind plus its distinguishing bits. */
function labelOf(n: unknown): { kind: string; detail: string } {
  if (!n || typeof n !== 'object') return { kind: String(n), detail: '' };
  const o = n as Record<string, unknown>;
  const kind = String(o.kind ?? (Array.isArray(n) ? 'list' : 'node'));
  switch (kind) {
    case 'IntLit': return { kind, detail: String(o.raw ?? o.value) };
    case 'FloatLit': return { kind, detail: String(o.raw) };
    case 'CharLit': return { kind, detail: `'${String.fromCharCode(Number(o.value))}'` };
    case 'StringLit': return { kind, detail: JSON.stringify(String.fromCharCode(...(o.bytes as number[]).slice(0, 24))) };
    case 'Ident': return { kind, detail: String(o.name) };
    case 'UnaryExpr': return { kind, detail: `${o.prefix ? '' : 'postfix '}${o.op}` };
    case 'BinaryExpr': case 'AssignExpr': return { kind, detail: String(o.op) };
    case 'MemberExpr': return { kind, detail: `${o.arrow ? '->' : '.'}${o.name}` };
    case 'CallExpr': return { kind, detail: `${(o.args as unknown[]).length} arg(s)` };
    case 'FunctionDef': return { kind, detail: A.declaratorName(o.declarator as A.Declarator) ?? '' };
    case 'Declaration': return { kind, detail: (o.declarators as A.InitDeclarator[]).map((d) => A.declaratorName(d.declarator) ?? '?').join(', ') };
    case 'IdentDeclarator': return { kind, detail: String(o.name ?? '(abstract)') };
    case 'PointerDeclarator': return { kind, detail: `*${o.qualConst ? ' const' : ''}` };
    case 'ArrayDeclarator': return { kind, detail: o.vla ? '[VLA]' : o.size ? '[n]' : '[]' };
    case 'FunctionDeclarator': return { kind, detail: `(${(o.params as unknown[]).length} param${o.variadic ? ', ...' : ''})` };
    case 'BasicType': return { kind, detail: String(o.name) };
    case 'TypedefName': return { kind, detail: String(o.name) };
    case 'StructUnion': return { kind, detail: `${o.su} ${o.tag ?? '<anon>'}${o.fields ? ' {…}' : ''}` };
    case 'Enum': return { kind, detail: `enum ${o.tag ?? ''}` };
    case 'GotoStmt': return { kind, detail: String(o.label) };
    case 'LabeledStmt': return { kind, detail: `${o.label}:` };
    case 'TranslationUnit': return { kind, detail: `${(o.decls as unknown[]).length} declaration(s)` };
    default: return { kind, detail: '' };
  }
}

const CHILD_KEYS = ['decls', 'specifiers', 'declarator', 'declarators', 'krDecls', 'body', 'items', 'init', 'expr', 'cond', 'then', 'else', 'left', 'right', 'operand', 'target', 'value', 'callee', 'args', 'base', 'index', 'step', 'disc', 'stmt', 'type', 'typeSpecs', 'inner', 'params', 'fields', 'enumerators', 'size', 'bitWidth', 'designators', 'decl'];

function childrenOf(n: unknown): [string, unknown][] {
  if (!n || typeof n !== 'object') return [];
  if (Array.isArray(n)) return n.map((x, k) => [String(k), x]);
  const o = n as Record<string, unknown>;
  const out: [string, unknown][] = [];
  for (const k of CHILD_KEYS) {
    const v = o[k];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'object') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === 'specifiers') {
      const sp = v as A.DeclSpecifiers;
      out.push([k, { kind: 'DeclSpecifiers', span: sp.span, typeSpecs: sp.typeSpecs, detail: `${sp.storage ? sp.storage + ' ' : ''}${sp.qualConst ? 'const ' : ''}` }]);
      continue;
    }
    out.push([k, v]);
  }
  return out;
}

const EXPR_KINDS = new Set(['IntLit', 'FloatLit', 'CharLit', 'StringLit', 'Ident', 'CallExpr', 'IndexExpr', 'MemberExpr', 'UnaryExpr', 'BinaryExpr', 'AssignExpr', 'CondExpr', 'CommaExpr', 'CastExpr', 'SizeofExpr', 'SizeofType']);

export function AstView({ unit, sema, activePath, onHover, onSelect }: Props) {
  const [showTypes, setShowTypes] = useState(true);
  const [showSpans, setShowSpans] = useState(false);
  const decls = unit.decls.filter((d) => d.span.start.file === activePath);
  return (
    <div className="ast" data-testid="ast">
      <div className="panel-toolbar">
        <label>
          <input type="checkbox" checked={showTypes} onChange={(e) => setShowTypes(e.target.checked)} /> show types (semantic analysis)
        </label>
        <label>
          <input type="checkbox" checked={showSpans} onChange={(e) => setShowSpans(e.target.checked)} /> show spans
        </label>
      </div>
      <div className="ast-tree" onMouseLeave={() => onHover(null)}>
        {decls.length === 0 && <p className="hint">Nothing parsed yet in this file.</p>}
        {decls.map((d, k) => (
          <AstNode key={k} name="" node={d} depth={0} sema={sema} showTypes={showTypes} showSpans={showSpans} onHover={onHover} onSelect={onSelect} open />
        ))}
      </div>
      <p className="hint">Hover a node to light up its source. Expression nodes show the type semantic analysis gave them; declarators nest from the identifier outwards.</p>
    </div>
  );
}

function AstNode({ name, node, depth, sema, showTypes, showSpans, onHover, onSelect, open: initOpen }: {
  name: string;
  node: unknown;
  depth: number;
  sema: SemaResult;
  showTypes: boolean;
  showSpans: boolean;
  onHover: (r: EditorRange | null) => void;
  onSelect: (r: EditorRange) => void;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initOpen ?? depth < 7);
  const { kind, detail } = labelOf(node);
  const kids = childrenOf(node);
  const span = (node as NodeLike)?.span;
  const extraDetail = (node as { detail?: string })?.detail;
  const type = showTypes && EXPR_KINDS.has(kind) ? sema.typeOf.get(node as A.Expr) : undefined;
  const sym = kind === 'Ident' ? sema.useOf.get(node as A.Ident) : undefined;
  const cls = EXPR_KINDS.has(kind) ? 'expr' : kind.endsWith('Stmt') ? 'stmt' : kind.endsWith('Declarator') ? 'declr' : kind === 'FunctionDef' || kind === 'Declaration' ? 'decl' : 'other';
  return (
    <div className="ast-node" style={{ marginLeft: depth === 0 ? 0 : 14 }}>
      <div
        className={`ast-row ${cls}`}
        onMouseEnter={() => span && onHover(rangeOf(span))}
        onClick={(e) => {
          e.stopPropagation();
          if (span) onSelect(rangeOf(span));
          setOpen(!open);
        }}
      >
        <span className="ast-toggle">{kids.length ? (open ? '▾' : '▸') : '·'}</span>
        {name && <span className="ast-field">{name}:</span>}
        <span className="ast-kind">{kind}</span>
        {(detail || extraDetail) && <span className="ast-detail">{extraDetail}{detail}</span>}
        {type && <span className="ast-type">: {formatType(type)}</span>}
        {sym && <span className="ast-sym">→ {sym.kind} declared line {sym.declSpan.start.line}</span>}
        {showSpans && span && (
          <span className="ast-span">
            {span.start.line}:{span.start.col}–{span.end.line}:{span.end.col}
          </span>
        )}
      </div>
      {open && kids.map(([k, v]) => <AstNode key={k} name={k} node={v} depth={depth + 1} sema={sema} showTypes={showTypes} showSpans={showSpans} onHover={onHover} onSelect={onSelect} />)}
    </div>
  );
}
