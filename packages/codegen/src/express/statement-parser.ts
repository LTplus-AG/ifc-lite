/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** EXPRESS statements, type specifications and LOCAL blocks. */

import type { AggregateKind, CaseBranch, Expr, LocalVariable, SimpleTypeName, Stmt, TypeSpec } from './ast.js';
import { parseExpression } from './expression-parser.js';
import type { TokenStream } from './token-stream.js';

const SIMPLE_TYPES = new Set<SimpleTypeName>(['REAL', 'INTEGER', 'NUMBER', 'BOOLEAN', 'LOGICAL', 'STRING', 'BINARY']);
const AGGREGATES = new Set<AggregateKind>(['LIST', 'SET', 'BAG', 'ARRAY', 'AGGREGATE']);

function isSimpleType(word: string): word is SimpleTypeName {
  return SIMPLE_TYPES.has(word as SimpleTypeName);
}

function isAggregate(word: string): word is AggregateKind {
  return AGGREGATES.has(word as AggregateKind);
}

function parseIdentifierList(s: TokenStream): string[] {
  s.expectOp('(');
  const items: string[] = [];
  do items.push(s.expectIdentifier()); while (s.acceptOp(','));
  s.expectOp(')');
  return items;
}

function parseExtensibleList(s: TokenStream, extensible: boolean): { items: string[]; basedOn?: string } {
  const basedOn = s.acceptKeyword('BASED_ON') ? s.expectIdentifier() : undefined;
  if (basedOn) s.acceptKeyword('WITH');
  const items = s.isOp('(') ? parseIdentifierList(s) : [];
  if (!extensible && !basedOn && items.length === 0) s.fail('expected item list');
  return basedOn ? { items, basedOn } : { items };
}

export function parseTypeSpec(s: TokenStream): TypeSpec {
  const t = s.peek();
  if (t.kind !== 'id') s.fail('expected type');
  const word = t.upper;
  if (isSimpleType(word)) {
    s.next();
    if ((word === 'STRING' || word === 'BINARY' || word === 'REAL') && s.acceptOp('(')) {
      const width = parseExpression(s);
      s.expectOp(')');
      const fixed = s.acceptKeyword('FIXED');
      return { k: 'simple', name: word, width, fixed };
    }
    return { k: 'simple', name: word };
  }
  if (isAggregate(word)) {
    s.next();
    let low: Expr | undefined;
    let high: Expr | undefined;
    if (s.acceptOp('[')) {
      low = parseExpression(s);
      s.expectOp(':');
      high = parseExpression(s);
      s.expectOp(']');
    }
    s.expectKeyword('OF');
    const optional = s.acceptKeyword('OPTIONAL');
    const unique = s.acceptKeyword('UNIQUE');
    return { k: 'aggregate', kind: word, low, high, optional, unique, of: parseTypeSpec(s) };
  }
  const extensible = s.acceptKeyword('EXTENSIBLE');
  if (extensible) s.acceptKeyword('GENERIC_ENTITY');
  if (s.acceptKeyword('ENUMERATION')) {
    if (s.acceptKeyword('OF')) return { k: 'enumeration', items: parseIdentifierList(s), extensible };
    return { k: 'enumeration', extensible, ...parseExtensibleList(s, extensible) };
  }
  if (s.acceptKeyword('SELECT')) return { k: 'select', extensible, ...parseExtensibleList(s, extensible) };
  if (extensible) s.fail('expected ENUMERATION or SELECT after EXTENSIBLE');
  if (s.acceptKeyword('GENERIC') || s.acceptKeyword('GENERIC_ENTITY')) {
    if (s.acceptOp(':')) s.expectIdentifier();
    return { k: 'generic', entity: word === 'GENERIC_ENTITY' };
  }
  s.next();
  return { k: 'named', name: t.text };
}

export function parseLocals(s: TokenStream): LocalVariable[] {
  const locals: LocalVariable[] = [];
  if (!s.acceptKeyword('LOCAL')) return locals;
  while (!s.acceptKeyword('END_LOCAL')) {
    const names = [s.expectIdentifier()];
    while (s.acceptOp(',')) names.push(s.expectIdentifier());
    s.expectOp(':');
    const type = parseTypeSpec(s);
    const init = s.acceptOp(':=') ? parseExpression(s) : undefined;
    s.expectOp(';');
    for (const name of names) locals.push(init ? { name, type, init } : { name, type });
  }
  s.expectOp(';');
  return locals;
}

export function parseStatements(s: TokenStream, terminators: string[]): Stmt[] {
  const body: Stmt[] = [];
  while (!terminators.some((w) => s.isKeyword(w)) && s.peek().kind !== 'eof') body.push(parseStatement(s));
  return body;
}

function parseIf(s: TokenStream): Stmt {
  const cond = parseExpression(s);
  s.expectKeyword('THEN');
  const thenBody = parseStatements(s, ['ELSE', 'END_IF']);
  const elseBody = s.acceptKeyword('ELSE') ? parseStatements(s, ['END_IF']) : undefined;
  s.expectKeyword('END_IF');
  s.expectOp(';');
  return elseBody ? { k: 'if', cond, thenBody, elseBody } : { k: 'if', cond, thenBody };
}

function parseCase(s: TokenStream): Stmt {
  const selector = parseExpression(s);
  s.expectKeyword('OF');
  const branches: CaseBranch[] = [];
  let otherwise: Stmt | undefined;
  while (!s.acceptKeyword('END_CASE')) {
    if (s.acceptKeyword('OTHERWISE')) {
      s.expectOp(':');
      otherwise = parseStatement(s);
      continue;
    }
    const labels = [parseExpression(s)];
    while (s.acceptOp(',')) labels.push(parseExpression(s));
    s.expectOp(':');
    branches.push({ labels, body: parseStatement(s) });
  }
  s.expectOp(';');
  return otherwise ? { k: 'case', selector, branches, otherwise } : { k: 'case', selector, branches };
}

function parseRepeat(s: TokenStream): Stmt {
  const stmt: Extract<Stmt, { k: 'repeat' }> = { k: 'repeat', body: [] };
  if (s.peek().kind === 'id' && s.isOp(':=', 1)) {
    stmt.variable = s.expectIdentifier();
    s.expectOp(':=');
    stmt.from = parseExpression(s);
    s.expectKeyword('TO');
    stmt.to = parseExpression(s);
    if (s.acceptKeyword('BY')) stmt.by = parseExpression(s);
  }
  if (s.acceptKeyword('WHILE')) stmt.whileCond = parseExpression(s);
  if (s.acceptKeyword('UNTIL')) stmt.untilCond = parseExpression(s);
  s.expectOp(';');
  stmt.body = parseStatements(s, ['END_REPEAT']);
  s.expectKeyword('END_REPEAT');
  s.expectOp(';');
  return stmt;
}

function parseStatement(s: TokenStream): Stmt {
  if (s.acceptOp(';')) return { k: 'null' };
  if (s.acceptKeyword('IF')) return parseIf(s);
  if (s.acceptKeyword('CASE')) return parseCase(s);
  if (s.acceptKeyword('REPEAT')) return parseRepeat(s);
  if (s.acceptKeyword('BEGIN')) {
    const body = parseStatements(s, ['END']);
    s.expectKeyword('END');
    s.expectOp(';');
    return { k: 'block', body };
  }
  if (s.acceptKeyword('RETURN')) {
    const value = s.isOp(';') ? undefined : parseExpression(s);
    s.expectOp(';');
    return value ? { k: 'return', value } : { k: 'return' };
  }
  if (s.acceptKeyword('ESCAPE')) { s.expectOp(';'); return { k: 'escape' }; }
  if (s.acceptKeyword('SKIP')) { s.expectOp(';'); return { k: 'skip' }; }
  if (s.acceptKeyword('ALIAS')) {
    const variable = s.expectIdentifier();
    s.expectKeyword('FOR');
    const target = parseExpression(s);
    s.expectOp(';');
    const body = parseStatements(s, ['END_ALIAS']);
    s.expectKeyword('END_ALIAS');
    s.expectOp(';');
    return { k: 'alias', variable, target, body };
  }
  const target = parseExpression(s);
  if (s.acceptOp(':=')) {
    const value = parseExpression(s);
    s.expectOp(';');
    return { k: 'assign', target, value };
  }
  s.expectOp(';');
  if (target.k === 'call') return { k: 'procedure', name: target.name, args: target.args };
  if (target.k === 'id') return { k: 'procedure', name: target.name, args: [] };
  return s.fail('expected assignment or procedure call');
}
