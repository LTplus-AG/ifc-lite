/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lexer for the IfcOpenShell selector syntax.
 *
 * The rules below are ifc-lite's reading of
 * <https://docs.ifcopenshell.org/ifcopenshell-python/selector_syntax.html>,
 * stated here because the page describes the language in prose rather than a
 * grammar:
 *
 * - Whitespace is insignificant outside quotes.
 * - `,` separates filters within a group, `+` separates groups.
 * - `!` immediately followed by `=` is the `!=` operator, followed by `*=` is
 *   `!*=`, and otherwise negates the class or GlobalId that follows.
 * - `*` is only ever part of `*=`. A trailing `*` is NOT a glob in this
 *   grammar, so `IfcWall*` is a lexical error rather than a silent no-match —
 *   the exact shape reported in #4091.
 * - `"…"` quotes a value; `\"` and `\\` escape inside it.
 * - `/…/` is a regular expression; `\/` escapes a slash inside the body. No
 *   trailing flags: the grammar has none, so `/foo/i` is a lexical error at
 *   the `i` rather than a silently different match.
 * - A bare word runs until whitespace or one of `,+=!<>*"/`, and may not start
 *   with `.`; a `.` in that leading position is the property-set separator, so
 *   both `Pset_WallCommon.FireRating` (one word, split by the parser) and
 *   `/Pset_.*Common/.FireRating` (regex, dot, word) read correctly while a
 *   decimal value such as `1.5` stays one word.
 */

import type { SelectorParseError } from './ast.js';

/** Lexeme classes. Not exported: `Token` is the only shape callers name. */
type TokenKind =
  | 'word'
  | 'string'
  | 'regex'
  | 'op'
  | 'comma'
  | 'plus'
  | 'bang'
  | 'dot';

export interface Token {
  kind: TokenKind;
  /** Word text, string/regex body, or the operator spelling. */
  value: string;
  /** 0-based offset of the token's first character. */
  start: number;
  /** 0-based offset one past the token's last character. */
  end: number;
}

export type TokenizeResult =
  | { ok: true; tokens: Token[] }
  | { ok: false; error: SelectorParseError };

/** Characters that end a bare word. */
const WORD_BREAK = new Set([',', '+', '=', '!', '<', '>', '*', '"', '/']);

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function fail(message: string, offset: number): TokenizeResult {
  return { ok: false, error: { message, offset } };
}

export function tokenizeSelector(text: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i] as string;

    if (isSpace(ch)) { i += 1; continue; }

    if (ch === ',') { tokens.push({ kind: 'comma', value: ',', start: i, end: i + 1 }); i += 1; continue; }
    if (ch === '+') { tokens.push({ kind: 'plus', value: '+', start: i, end: i + 1 }); i += 1; continue; }
    if (ch === '.') { tokens.push({ kind: 'dot', value: '.', start: i, end: i + 1 }); i += 1; continue; }

    if (ch === '!') {
      if (text[i + 1] === '=') {
        tokens.push({ kind: 'op', value: '!=', start: i, end: i + 2 });
        i += 2;
      } else if (text[i + 1] === '*' && text[i + 2] === '=') {
        tokens.push({ kind: 'op', value: '!*=', start: i, end: i + 3 });
        i += 3;
      } else {
        tokens.push({ kind: 'bang', value: '!', start: i, end: i + 1 });
        i += 1;
      }
      continue;
    }

    if (ch === '*') {
      if (text[i + 1] !== '=') {
        return fail(
          `"*" is only valid as part of the "*=" (contains) operator; this grammar has no "*" wildcard. Use a regular expression such as /Ifc.*Wall/ instead.`,
          i,
        );
      }
      tokens.push({ kind: 'op', value: '*=', start: i, end: i + 2 });
      i += 2;
      continue;
    }

    if (ch === '=') { tokens.push({ kind: 'op', value: '=', start: i, end: i + 1 }); i += 1; continue; }

    if (ch === '<' || ch === '>') {
      const two = text[i + 1] === '=';
      const value = two ? `${ch}=` : ch;
      tokens.push({ kind: 'op', value, start: i, end: i + value.length });
      i += value.length;
      continue;
    }

    if (ch === '"') {
      const quoted = readQuoted(text, i);
      if (!quoted.ok) return quoted;
      tokens.push(quoted.token);
      i = quoted.token.end;
      continue;
    }

    if (ch === '/') {
      const regex = readRegex(text, i);
      if (!regex.ok) return regex;
      tokens.push(regex.token);
      i = regex.token.end;
      continue;
    }

    const start = i;
    while (i < text.length) {
      const c = text[i] as string;
      if (isSpace(c) || WORD_BREAK.has(c)) break;
      i += 1;
    }
    tokens.push({ kind: 'word', value: text.slice(start, i), start, end: i });
  }

  return { ok: true, tokens };
}

type ReadResult = { ok: true; token: Token } | { ok: false; error: SelectorParseError };

/** `"foo \"bar\" baz"` — the token value is the unescaped body. */
function readQuoted(text: string, start: number): ReadResult {
  let out = '';
  let i = start + 1;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '\\') {
      const next = text[i + 1];
      if (next === undefined) break;
      out += next;
      i += 2;
      continue;
    }
    if (c === '"') {
      return { ok: true, token: { kind: 'string', value: out, start, end: i + 1 } };
    }
    out += c;
    i += 1;
  }
  return { ok: false, error: { message: 'unterminated quoted value: no closing "', offset: start } };
}

/** `/foo\/bar/` — the token value is the regex source with `\/` unescaped. */
function readRegex(text: string, start: number): ReadResult {
  let out = '';
  let i = start + 1;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '\\') {
      const next = text[i + 1];
      if (next === undefined) break;
      // Only `\/` is about the delimiter; every other escape belongs to the
      // regular expression and is handed through untouched.
      out += next === '/' ? '/' : `\\${next}`;
      i += 2;
      continue;
    }
    if (c === '/') {
      if (out.length === 0) {
        return { ok: false, error: { message: 'empty regular expression: // matches nothing', offset: start } };
      }
      return { ok: true, token: { kind: 'regex', value: out, start, end: i + 1 } };
    }
    out += c;
    i += 1;
  }
  return { ok: false, error: { message: 'unterminated regular expression: no closing /', offset: start } };
}
