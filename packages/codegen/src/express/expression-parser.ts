/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Recursive-descent parser for EXPRESS expressions (ISO 10303-11 §12). */

import type { AggregateItem, BinaryOp, Expr } from './ast.js';
import type { TokenStream } from './token-stream.js';

const RELATIONAL = new Set(['=', '<>', '<', '>', '<=', '>=', ':=:', ':<>:']);
const RELATIONAL_WORDS = new Set(['IN', 'LIKE']);
const ADDITIVE = new Set(['+', '-']);
const ADDITIVE_WORDS = new Set(['OR', 'XOR']);
const MULTIPLICATIVE = new Set(['*', '/', '||']);
const MULTIPLICATIVE_WORDS = new Set(['DIV', 'MOD', 'AND']);

function binaryOp(s: TokenStream, ops: Set<string>, words: Set<string>): BinaryOp | undefined {
  const t = s.peek();
  if (t.kind === 'op' && ops.has(t.text)) return t.text as BinaryOp;
  if (t.kind === 'id' && words.has(t.upper)) return t.upper as BinaryOp;
  return undefined;
}

export function parseExpression(s: TokenStream): Expr {
  const left = parseSimpleExpression(s);
  const op = binaryOp(s, RELATIONAL, RELATIONAL_WORDS);
  if (!op) return left;
  s.next();
  return { k: 'binary', op, left, right: parseSimpleExpression(s) };
}

function parseSimpleExpression(s: TokenStream): Expr {
  let left = parseTerm(s);
  for (let op = binaryOp(s, ADDITIVE, ADDITIVE_WORDS); op; op = binaryOp(s, ADDITIVE, ADDITIVE_WORDS)) {
    s.next();
    left = { k: 'binary', op, left, right: parseTerm(s) };
  }
  return left;
}

function parseTerm(s: TokenStream): Expr {
  let left = parseFactor(s);
  for (let op = binaryOp(s, MULTIPLICATIVE, MULTIPLICATIVE_WORDS); op; op = binaryOp(s, MULTIPLICATIVE, MULTIPLICATIVE_WORDS)) {
    s.next();
    left = { k: 'binary', op, left, right: parseFactor(s) };
  }
  return left;
}

function parseFactor(s: TokenStream): Expr {
  const left = parseSimpleFactor(s);
  if (!s.acceptOp('**')) return left;
  return { k: 'binary', op: '**', left, right: parseSimpleFactor(s) };
}

function parseSimpleFactor(s: TokenStream): Expr {
  if (s.acceptOp('-')) return { k: 'unary', op: '-', operand: parseSimpleFactor(s) };
  if (s.acceptOp('+')) return { k: 'unary', op: '+', operand: parseSimpleFactor(s) };
  if (s.acceptKeyword('NOT')) return { k: 'unary', op: 'NOT', operand: parseSimpleFactor(s) };
  return parseQualifiers(s, parsePrimary(s));
}

function parseQualifiers(s: TokenStream, base: Expr): Expr {
  for (;;) {
    if (s.acceptOp('.')) {
      base = { k: 'attr', base, name: s.expectIdentifier() };
    } else if (s.acceptOp('\\')) {
      base = { k: 'group', base, entity: s.expectIdentifier() };
    } else if (s.isOp('[')) {
      s.next();
      const index = parseExpression(s);
      const upper = s.acceptOp(':') ? parseExpression(s) : undefined;
      s.expectOp(']');
      base = upper ? { k: 'index', base, index, upper } : { k: 'index', base, index };
    } else {
      return base;
    }
  }
}

function parseArguments(s: TokenStream): Expr[] {
  s.expectOp('(');
  const args: Expr[] = [];
  if (!s.isOp(')')) {
    do args.push(parseExpression(s)); while (s.acceptOp(','));
  }
  s.expectOp(')');
  return args;
}

function parseAggregateInitializer(s: TokenStream): Expr {
  s.expectOp('[');
  const items: AggregateItem[] = [];
  if (!s.isOp(']')) {
    do {
      const value = parseExpression(s);
      items.push(s.acceptOp(':') ? { value, repeat: parseExpression(s) } : { value });
    } while (s.acceptOp(','));
  }
  s.expectOp(']');
  return { k: 'aggregate', items };
}

function intervalOp(s: TokenStream): '<' | '<=' {
  if (s.acceptOp('<=')) return '<=';
  s.expectOp('<');
  return '<';
}

function parseInterval(s: TokenStream): Expr {
  s.expectOp('{');
  const low = parseSimpleExpression(s);
  const op1 = intervalOp(s);
  const item = parseSimpleExpression(s);
  const op2 = intervalOp(s);
  const high = parseSimpleExpression(s);
  s.expectOp('}');
  return { k: 'interval', low, op1, item, op2, high };
}

function parseQuery(s: TokenStream): Expr {
  s.expectOp('(');
  const variable = s.expectIdentifier();
  s.expectOp('<*');
  const source = parseExpression(s);
  s.expectOp('|');
  const predicate = parseExpression(s);
  s.expectOp(')');
  return { k: 'query', variable, source, predicate };
}

function parsePrimary(s: TokenStream): Expr {
  const t = s.peek();
  if (t.kind === 'int' || t.kind === 'real') {
    s.next();
    return { k: 'num', value: Number(t.text), int: t.kind === 'int' };
  }
  if (t.kind === 'str') {
    s.next();
    return { k: 'str', value: t.text };
  }
  if (t.kind === 'op') {
    if (t.text === '?') { s.next(); return { k: 'indeterminate' }; }
    if (t.text === '(') {
      s.next();
      const inner = parseExpression(s);
      s.expectOp(')');
      return inner;
    }
    if (t.text === '[') return parseAggregateInitializer(s);
    if (t.text === '{') return parseInterval(s);
    s.fail('expected expression');
  }
  if (t.kind !== 'id') s.fail('expected expression');
  s.next();
  switch (t.upper) {
    case 'SELF': return { k: 'self' };
    case 'TRUE': case 'FALSE': case 'UNKNOWN': return { k: 'logical', value: t.upper };
    case 'PI': case 'CONST_E': return { k: 'const', name: t.upper };
    case 'QUERY': return parseQuery(s);
  }
  if (s.isOp('(')) return { k: 'call', name: t.text, args: parseArguments(s) };
  return { k: 'id', name: t.text };
}
