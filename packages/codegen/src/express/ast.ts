/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** AST for the EXPRESS declarations, statements and expressions IFC uses. */

export type Expr =
  | { k: 'num'; value: number; int: boolean }
  | { k: 'str'; value: string }
  | { k: 'logical'; value: 'TRUE' | 'FALSE' | 'UNKNOWN' }
  | { k: 'indeterminate' }
  | { k: 'self' }
  | { k: 'const'; name: 'PI' | 'CONST_E' }
  | { k: 'id'; name: string }
  | { k: 'attr'; base: Expr; name: string }
  | { k: 'group'; base: Expr; entity: string }
  | { k: 'index'; base: Expr; index: Expr; upper?: Expr }
  | { k: 'call'; name: string; args: Expr[] }
  | { k: 'unary'; op: '-' | '+' | 'NOT'; operand: Expr }
  | { k: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { k: 'aggregate'; items: AggregateItem[] }
  | { k: 'query'; variable: string; source: Expr; predicate: Expr }
  | { k: 'interval'; low: Expr; op1: '<' | '<='; item: Expr; op2: '<' | '<='; high: Expr };

export type BinaryOp =
  | '+' | '-' | '*' | '/' | 'DIV' | 'MOD' | '**' | '||'
  | 'AND' | 'OR' | 'XOR'
  | '=' | '<>' | '<' | '>' | '<=' | '>=' | ':=:' | ':<>:' | 'IN' | 'LIKE';

export interface AggregateItem {
  value: Expr;
  repeat?: Expr;
}

export type Stmt =
  | { k: 'assign'; target: Expr; value: Expr }
  | { k: 'if'; cond: Expr; thenBody: Stmt[]; elseBody?: Stmt[] }
  | { k: 'case'; selector: Expr; branches: CaseBranch[]; otherwise?: Stmt }
  | { k: 'repeat'; variable?: string; from?: Expr; to?: Expr; by?: Expr; whileCond?: Expr; untilCond?: Expr; body: Stmt[] }
  | { k: 'return'; value?: Expr }
  | { k: 'escape' }
  | { k: 'skip' }
  | { k: 'block'; body: Stmt[] }
  | { k: 'procedure'; name: string; args: Expr[] }
  | { k: 'alias'; variable: string; target: Expr; body: Stmt[] }
  | { k: 'null' };

export interface CaseBranch {
  labels: Expr[];
  body: Stmt;
}

export type SimpleTypeName = 'REAL' | 'INTEGER' | 'NUMBER' | 'BOOLEAN' | 'LOGICAL' | 'STRING' | 'BINARY';
export type AggregateKind = 'LIST' | 'SET' | 'BAG' | 'ARRAY' | 'AGGREGATE';

export type TypeSpec =
  | { k: 'simple'; name: SimpleTypeName; spelling?: string; width?: Expr; fixed?: boolean }
  | { k: 'named'; name: string }
  | { k: 'aggregate'; kind: AggregateKind; spelling?: string; low?: Expr; high?: Expr; optional: boolean; unique: boolean; of: TypeSpec }
  | { k: 'enumeration'; items: string[]; extensible: boolean; basedOn?: string }
  | { k: 'select'; items: string[]; extensible: boolean; basedOn?: string }
  | { k: 'generic'; entity: boolean };

export interface WhereRule {
  label: string;
  expr: Expr;
  source: string;
}

export interface Redeclaration {
  entity: string;
  attribute: string;
}

export interface ExplicitAttribute {
  name: string;
  optional: boolean;
  type: TypeSpec;
  redeclares?: Redeclaration;
}

export interface DerivedAttribute {
  name: string;
  type: TypeSpec;
  expr: Expr;
  source: string;
  redeclares?: Redeclaration;
}

export interface InverseAttribute {
  name: string;
  aggregate?: 'SET' | 'BAG';
  low?: Expr;
  high?: Expr;
  entity: string;
  forAttribute: string;
  redeclares?: Redeclaration;
}

export interface UniqueRule {
  label: string;
  attributes: { entity?: string; name: string }[];
}

export interface EntityDecl {
  name: string;
  abstract: boolean;
  supertypes: string[];
  subtypeNames?: string[];
  explicit: ExplicitAttribute[];
  derived: DerivedAttribute[];
  inverse: InverseAttribute[];
  unique: UniqueRule[];
  where: WhereRule[];
}

export interface TypeDecl {
  source: string;
  name: string;
  spec: TypeSpec;
  where: WhereRule[];
}

export interface LocalVariable {
  name: string;
  type: TypeSpec;
  init?: Expr;
}

export interface FunctionDecl {
  name: string;
  params: { name: string; type: TypeSpec }[];
  returns: TypeSpec;
  locals: LocalVariable[];
  body: Stmt[];
}

export interface RuleDecl {
  name: string;
  appliesTo: string[];
  locals: LocalVariable[];
  body: Stmt[];
  where: WhereRule[];
}

export interface ExpressRuleSchema {
  name: string;
  types: TypeDecl[];
  entities: EntityDecl[];
  functions: FunctionDecl[];
  rules: RuleDecl[];
  /** Declarations the parser recognised but does not model (PROCEDURE, CONSTANT, ...). */
  skipped: { kind: string; name: string }[];
}
