/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** ISO 10303-11 lexer for the EXPRESS used by the IFC schemas. */

export type TokenKind = 'id' | 'int' | 'real' | 'str' | 'op' | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  /** Upper-cased `text` for identifiers, so keyword checks are case-insensitive. */
  upper: string;
  start: number;
  end: number;
}

export class ExpressSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
    this.name = 'ExpressSyntaxError';
  }
}

const OPERATORS = [':=:', ':<>:', ':=', '<*', '<=', '>=', '<>', '||', '**',
  '+', '-', '*', '/', '=', '<', '>', '(', ')', '[', ']', '{', '}', ',', ';', ':', '.', '\\', '|', '?'];

const isDigit = (c: number) => c >= 48 && c <= 57;
const isIdStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isIdPart = (c: number) => isIdStart(c) || isDigit(c) || c === 95;

function skipRemark(src: string, i: number): number {
  let depth = 1;
  i += 2;
  while (i < src.length && depth > 0) {
    if (src.startsWith('(*', i)) { depth++; i += 2; }
    else if (src.startsWith('*)', i)) { depth--; i += 2; }
    else i++;
  }
  if (depth > 0) throw new ExpressSyntaxError('unterminated (* remark', i);
  return i;
}

function readNumber(src: string, i: number): { end: number; real: boolean } {
  let j = i;
  while (j < src.length && isDigit(src.charCodeAt(j))) j++;
  let real = false;
  if (src[j] === '.') {
    real = true;
    j++;
    while (j < src.length && isDigit(src.charCodeAt(j))) j++;
  }
  if ((src[j] === 'E' || src[j] === 'e') && /[+\-\d]/.test(src[j + 1] ?? '')) {
    real = true;
    j += src[j + 1] === '+' || src[j + 1] === '-' ? 2 : 1;
    if (!isDigit(src.charCodeAt(j))) throw new ExpressSyntaxError('expected exponent digits', j);
    while (j < src.length && isDigit(src.charCodeAt(j))) j++;
  }
  return { end: j, real };
}

function readString(src: string, i: number): { end: number; value: string } {
  let j = i + 1;
  let value = '';
  for (;;) {
    if (j >= src.length) throw new ExpressSyntaxError('unterminated string literal', i);
    if (src[j] === "'") {
      if (src[j + 1] === "'") { value += "'"; j += 2; continue; }
      return { end: j + 1, value };
    }
    value += src[j++];
  }
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  // A byte-order mark survives readFileSync(..., 'utf8'); it is not part of the schema.
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const push = (kind: TokenKind, text: string, start: number, end: number) =>
    tokens.push({ kind, text, upper: kind === 'id' ? text.toUpperCase() : text, start, end });
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c <= 32) { i++; continue; }
    if (src.startsWith('(*', i)) { i = skipRemark(src, i); continue; }
    if (src.startsWith('--', i)) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdPart(src.charCodeAt(j))) j++;
      push('id', src.slice(i, j), i, j);
      i = j;
      continue;
    }
    if (isDigit(c)) {
      const { end, real } = readNumber(src, i);
      push(real ? 'real' : 'int', src.slice(i, end), i, end);
      i = end;
      continue;
    }
    if (c === 39) {
      const { end, value } = readString(src, i);
      push('str', value, i, end);
      i = end;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressSyntaxError(`unexpected character '${src[i]}'`, i);
    push('op', op, i, i + op.length);
    i += op.length;
  }
  push('eof', '', src.length, src.length);
  return tokens;
}
