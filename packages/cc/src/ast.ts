import type { Span } from './token';

/**
 * The C89 (+friendly extras) abstract syntax tree. The parser produces syntax
 * only: declaration specifiers plus nested declarators. Semantic analysis (M4)
 * folds a specifier list + declarator into a concrete type and a symbol. Every
 * node carries a source `span` for go-to-definition, error underlines, and the
 * debugger. Node unions are discriminated by `kind`.
 */

export interface Node {
  span: Span;
}

// -- expressions -------------------------------------------------------------

export type Expr =
  | IntLit
  | FloatLit
  | CharLit
  | StringLit
  | Ident
  | CallExpr
  | IndexExpr
  | MemberExpr
  | UnaryExpr
  | BinaryExpr
  | AssignExpr
  | CondExpr
  | CommaExpr
  | CastExpr
  | SizeofExpr
  | SizeofType;

export interface IntLit extends Node {
  kind: 'IntLit';
  value: bigint;
  unsigned: boolean;
  rank: 'int' | 'long' | 'llong';
  raw: string;
}
export interface FloatLit extends Node {
  kind: 'FloatLit';
  value: number;
  type: 'float' | 'double' | 'ldouble';
  raw: string;
}
export interface CharLit extends Node {
  kind: 'CharLit';
  value: number;
  wide: boolean;
}
export interface StringLit extends Node {
  kind: 'StringLit';
  /** Concatenated bytes (adjacent literals merged), NUL not included. */
  bytes: number[];
  wide: boolean;
}
export interface Ident extends Node {
  kind: 'Ident';
  name: string;
}
export interface CallExpr extends Node {
  kind: 'CallExpr';
  callee: Expr;
  args: Expr[];
}
export interface IndexExpr extends Node {
  kind: 'IndexExpr';
  base: Expr;
  index: Expr;
}
export interface MemberExpr extends Node {
  kind: 'MemberExpr';
  base: Expr;
  name: string;
  arrow: boolean;
}
export interface UnaryExpr extends Node {
  kind: 'UnaryExpr';
  op: '+' | '-' | '!' | '~' | '*' | '&' | '++' | '--';
  operand: Expr;
  prefix: boolean;
}
export interface BinaryExpr extends Node {
  kind: 'BinaryExpr';
  op: string;
  left: Expr;
  right: Expr;
}
export interface AssignExpr extends Node {
  kind: 'AssignExpr';
  op: string; // '=', '+=', ...
  target: Expr;
  value: Expr;
}
export interface CondExpr extends Node {
  kind: 'CondExpr';
  cond: Expr;
  then: Expr;
  else: Expr;
}
export interface CommaExpr extends Node {
  kind: 'CommaExpr';
  items: Expr[];
}
export interface CastExpr extends Node {
  kind: 'CastExpr';
  type: TypeName;
  operand: Expr;
}
export interface SizeofExpr extends Node {
  kind: 'SizeofExpr';
  operand: Expr;
}
export interface SizeofType extends Node {
  kind: 'SizeofType';
  type: TypeName;
}

// -- declaration specifiers & declarators ------------------------------------

export type StorageClass = 'typedef' | 'extern' | 'static' | 'auto' | 'register';

export type TypeSpec = BasicTypeSpec | TypedefNameSpec | StructUnionSpec | EnumSpec;

export interface BasicTypeSpec extends Node {
  kind: 'BasicType';
  name: 'void' | 'char' | 'short' | 'int' | 'long' | 'float' | 'double' | 'signed' | 'unsigned' | '_Bool';
}
export interface TypedefNameSpec extends Node {
  kind: 'TypedefName';
  name: string;
}
export interface StructUnionSpec extends Node {
  kind: 'StructUnion';
  su: 'struct' | 'union';
  tag?: string;
  /** null when this is only a reference (`struct Foo x;`). */
  fields: StructField[] | null;
}
export interface EnumSpec extends Node {
  kind: 'Enum';
  tag?: string;
  enumerators: Enumerator[] | null;
}
export interface Enumerator extends Node {
  name: string;
  value: Expr | null;
}
export interface StructField extends Node {
  specifiers: DeclSpecifiers;
  declarator: Declarator | null; // null for anonymous
  bitWidth: Expr | null;
}

export interface DeclSpecifiers extends Node {
  storage?: StorageClass;
  typeSpecs: TypeSpec[];
  qualConst: boolean;
  qualVolatile: boolean;
  inline: boolean;
}

export type Declarator = IdentDeclarator | PointerDeclarator | ArrayDeclarator | FunctionDeclarator;

export interface IdentDeclarator extends Node {
  kind: 'IdentDeclarator';
  /** Absent for abstract declarators (type names, unnamed params). */
  name?: string;
}
export interface PointerDeclarator extends Node {
  kind: 'PointerDeclarator';
  qualConst: boolean;
  qualVolatile: boolean;
  inner: Declarator;
}
export interface ArrayDeclarator extends Node {
  kind: 'ArrayDeclarator';
  inner: Declarator;
  size: Expr | null; // null = incomplete []
  vla: boolean; // true when size is a non-constant expression
}
export interface FunctionDeclarator extends Node {
  kind: 'FunctionDeclarator';
  inner: Declarator;
  params: ParamDecl[];
  variadic: boolean;
  /** true when this is an old-style (K&R) identifier list. */
  kr: boolean;
  hasProto: boolean;
}
export interface ParamDecl extends Node {
  specifiers: DeclSpecifiers;
  declarator: Declarator | null;
}

export interface TypeName extends Node {
  specifiers: DeclSpecifiers;
  declarator: Declarator | null; // abstract
}

// -- declarations ------------------------------------------------------------

export interface InitDeclarator extends Node {
  declarator: Declarator;
  init: Initializer | null;
}
export interface Declaration extends Node {
  kind: 'Declaration';
  specifiers: DeclSpecifiers;
  declarators: InitDeclarator[];
}

export type Initializer = ExprInit | ListInit;
export interface ExprInit extends Node {
  kind: 'ExprInit';
  expr: Expr;
}
export interface ListInit extends Node {
  kind: 'ListInit';
  items: InitItem[];
}
export interface InitItem extends Node {
  /** Designators (C99, friendly extra): [i] or .field chains; empty for positional. */
  designators: Designator[];
  init: Initializer;
}
export type Designator =
  | { kind: 'array'; index: Expr; span: Span }
  | { kind: 'field'; name: string; span: Span };

// -- statements --------------------------------------------------------------

export type Stmt =
  | CompoundStmt
  | ExprStmt
  | IfStmt
  | WhileStmt
  | DoWhileStmt
  | ForStmt
  | SwitchStmt
  | BreakStmt
  | ContinueStmt
  | ReturnStmt
  | GotoStmt
  | LabeledStmt
  | CaseStmt
  | DefaultStmt
  | EmptyStmt
  | DeclStmt;

export type BlockItem = Stmt | Declaration;

export interface CompoundStmt extends Node {
  kind: 'CompoundStmt';
  items: BlockItem[];
}
export interface DeclStmt extends Node {
  kind: 'DeclStmt';
  decl: Declaration;
}
export interface ExprStmt extends Node {
  kind: 'ExprStmt';
  expr: Expr | null;
}
export interface IfStmt extends Node {
  kind: 'IfStmt';
  cond: Expr;
  then: Stmt;
  else: Stmt | null;
}
export interface WhileStmt extends Node {
  kind: 'WhileStmt';
  cond: Expr;
  body: Stmt;
}
export interface DoWhileStmt extends Node {
  kind: 'DoWhileStmt';
  body: Stmt;
  cond: Expr;
}
export interface ForStmt extends Node {
  kind: 'ForStmt';
  init: Declaration | Expr | null;
  cond: Expr | null;
  step: Expr | null;
  body: Stmt;
}
export interface SwitchStmt extends Node {
  kind: 'SwitchStmt';
  disc: Expr;
  body: Stmt;
}
export interface BreakStmt extends Node {
  kind: 'BreakStmt';
}
export interface ContinueStmt extends Node {
  kind: 'ContinueStmt';
}
export interface ReturnStmt extends Node {
  kind: 'ReturnStmt';
  value: Expr | null;
}
export interface GotoStmt extends Node {
  kind: 'GotoStmt';
  label: string;
}
export interface LabeledStmt extends Node {
  kind: 'LabeledStmt';
  label: string;
  stmt: Stmt;
}
export interface CaseStmt extends Node {
  kind: 'CaseStmt';
  value: Expr;
  stmt: Stmt;
}
export interface DefaultStmt extends Node {
  kind: 'DefaultStmt';
  stmt: Stmt;
}
export interface EmptyStmt extends Node {
  kind: 'EmptyStmt';
}

// -- top level ---------------------------------------------------------------

export type ExternalDecl = FunctionDef | Declaration;

export interface FunctionDef extends Node {
  kind: 'FunctionDef';
  specifiers: DeclSpecifiers;
  declarator: Declarator;
  /** K&R parameter declarations appearing before the body. */
  krDecls: Declaration[];
  body: CompoundStmt;
}

export interface TranslationUnit extends Node {
  kind: 'TranslationUnit';
  decls: ExternalDecl[];
}

/** Walk the declarator chain to its innermost identifier. */
export function declaratorName(d: Declarator | null): string | undefined {
  let cur: Declarator | null = d;
  while (cur) {
    if (cur.kind === 'IdentDeclarator') return cur.name;
    cur = cur.inner;
  }
  return undefined;
}
