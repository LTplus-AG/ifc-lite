/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `when` clause parser.
 *
 * Grammar (loose, recursive-descent):
 *
 *   expr      := or
 *   or        := and ( "||" and )*
 *   and       := not ( "&&" not )*
 *   not       := "!" not | compare
 *   compare   := primary ( cmpOp primary )?
 *   cmpOp     := "==" | "!=" | "<=" | ">=" | "<" | ">"
 *   primary   := "(" expr ")" | literal | identifier
 *   literal   := string | number | bool
 *   string    := "'" chars "'"
 *   number    := [0-9]+ ( "." [0-9]+ )?
 *   bool      := "true" | "false"
 *   identifier:= [A-Za-z_] [A-Za-z0-9_.]*
 *
 * Context keys are validated by the evaluator, not the parser. The parser
 * only enforces shape; the evaluator enforces the v1 key allow-list.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §5.1.
 */

import type {
  WhenCompareOp,
  WhenExpression,
  ValidationResult,
} from '../types.js';

interface TokenStream {
  source: string;
  pos: number;
}

export function parseWhen(source: string): ValidationResult<WhenExpression> {
  if (typeof source !== 'string') {
    return failParse('when clause must be a string.', 0);
  }
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return failParse('when clause is empty.', 0);
  }
  const stream: TokenStream = { source: trimmed, pos: 0 };
  try {
    const expr = parseExpr(stream);
    skipWs(stream);
    if (stream.pos !== stream.source.length) {
      return failParse(`Unexpected trailing input at position ${stream.pos}.`, stream.pos);
    }
    return { ok: true, value: expr };
  } catch (err) {
    if (err instanceof WhenParseError) {
      return failParse(err.message, err.pos);
    }
    throw err;
  }
}

class WhenParseError extends Error {
  constructor(message: string, public readonly pos: number) {
    super(message);
    this.name = 'WhenParseError';
  }
}

function failParse(message: string, pos: number): ValidationResult<never> {
  return {
    ok: false,
    errors: [
      {
        path: `[${pos}]`,
        code: 'invalid_when',
        message,
      },
    ],
  };
}

function parseExpr(s: TokenStream): WhenExpression {
  return parseOr(s);
}

function parseOr(s: TokenStream): WhenExpression {
  let left = parseAnd(s);
  while (matchSymbol(s, '||')) {
    const right = parseAnd(s);
    left = { kind: 'or', left, right };
  }
  return left;
}

function parseAnd(s: TokenStream): WhenExpression {
  let left = parseNot(s);
  while (matchSymbol(s, '&&')) {
    const right = parseNot(s);
    left = { kind: 'and', left, right };
  }
  return left;
}

function parseNot(s: TokenStream): WhenExpression {
  if (matchSymbol(s, '!')) {
    const operand = parseNot(s);
    return { kind: 'not', operand };
  }
  return parseCompare(s);
}

function parseCompare(s: TokenStream): WhenExpression {
  const left = parsePrimary(s);
  const op = matchCompareOp(s);
  if (!op) return left;
  const right = parsePrimary(s);
  return { kind: 'compare', op, left, right };
}

function parsePrimary(s: TokenStream): WhenExpression {
  skipWs(s);
  if (s.pos >= s.source.length) {
    throw new WhenParseError('Expected expression.', s.pos);
  }

  const ch = s.source[s.pos];

  if (ch === '(') {
    s.pos += 1;
    const inner = parseExpr(s);
    skipWs(s);
    if (s.source[s.pos] !== ')') {
      throw new WhenParseError('Expected ")".', s.pos);
    }
    s.pos += 1;
    return inner;
  }

  if (ch === "'" || ch === '"') {
    return parseString(s, ch);
  }

  if (ch >= '0' && ch <= '9') {
    return parseNumber(s);
  }

  if (isIdentStart(ch)) {
    return parseIdentifierOrKeyword(s);
  }

  throw new WhenParseError(`Unexpected character "${ch}".`, s.pos);
}

function parseString(s: TokenStream, quote: string): WhenExpression {
  const start = s.pos;
  s.pos += 1;
  let value = '';
  while (s.pos < s.source.length) {
    const c = s.source[s.pos];
    if (c === '\\' && s.pos + 1 < s.source.length) {
      value += s.source[s.pos + 1];
      s.pos += 2;
      continue;
    }
    if (c === quote) {
      s.pos += 1;
      return { kind: 'literal', value };
    }
    value += c;
    s.pos += 1;
  }
  throw new WhenParseError('Unterminated string literal.', start);
}

function parseNumber(s: TokenStream): WhenExpression {
  const start = s.pos;
  while (s.pos < s.source.length && /[0-9]/.test(s.source[s.pos])) s.pos += 1;
  if (s.source[s.pos] === '.') {
    s.pos += 1;
    while (s.pos < s.source.length && /[0-9]/.test(s.source[s.pos])) s.pos += 1;
  }
  const raw = s.source.slice(start, s.pos);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new WhenParseError(`Invalid number "${raw}".`, start);
  }
  return { kind: 'literal', value };
}

function parseIdentifierOrKeyword(s: TokenStream): WhenExpression {
  const start = s.pos;
  while (s.pos < s.source.length && isIdentContinue(s.source[s.pos])) s.pos += 1;
  const name = s.source.slice(start, s.pos);

  if (name === 'true') return { kind: 'literal', value: true };
  if (name === 'false') return { kind: 'literal', value: false };

  return { kind: 'identifier', name };
}

function matchSymbol(s: TokenStream, sym: string): boolean {
  skipWs(s);
  if (s.source.startsWith(sym, s.pos)) {
    // For "&&" / "||" / "!", make sure we don't swallow start of "!="
    if (sym === '!' && s.source[s.pos + 1] === '=') return false;
    s.pos += sym.length;
    return true;
  }
  return false;
}

function matchCompareOp(s: TokenStream): WhenCompareOp | undefined {
  skipWs(s);
  const candidates: WhenCompareOp[] = ['==', '!=', '<=', '>=', '<', '>'];
  for (const op of candidates) {
    if (s.source.startsWith(op, s.pos)) {
      s.pos += op.length;
      return op;
    }
  }
  return undefined;
}

function skipWs(s: TokenStream): void {
  while (s.pos < s.source.length && /\s/.test(s.source[s.pos])) s.pos += 1;
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentContinue(ch: string): boolean {
  return /[A-Za-z0-9_.]/.test(ch);
}
