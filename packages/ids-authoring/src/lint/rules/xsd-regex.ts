/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A small XSD-regex tokenizer and plain-language explainer.
 *
 * XSD patterns (XML Schema Part 2, Appendix F) differ from the regex
 * dialects authors know: every pattern is implicitly anchored, `^` and `$`
 * are ordinary characters, there are no lookarounds, backreferences, lazy
 * quantifiers or `(?…)` groups, and `\d`, `\w` are Unicode classes. The
 * tokenizer is linear and never compiles the pattern, so it is safe on any
 * input; matching itself goes through `@ifc-lite/ids`' translator and the
 * ReDoS guard.
 */

export type XsdTokenKind =
  | 'char'
  | 'escape'
  | 'classEscape'
  | 'property'
  | 'invalidEscape'
  | 'class'
  | 'any'
  | 'open'
  | 'openSpecial'
  | 'close'
  | 'alt'
  | 'quantifier'
  | 'lazy'
  | 'caret'
  | 'dollar';

export interface XsdToken {
  kind: XsdTokenKind;
  text: string;
  /** Offset in the pattern. */
  start: number;
}

const SINGLE_ESCAPES = new Set(['n', 'r', 't', '\\', '|', '.', '-', '^', '?', '*', '+', '{', '}', '(', ')', '[', ']']);
const CLASS_ESCAPES = new Set(['d', 'D', 's', 'S', 'w', 'W', 'i', 'I', 'c', 'C']);

function escapeAt(p: string, i: number): { kind: XsdTokenKind; text: string } {
  const c = p[i + 1];
  if (c === undefined) return { kind: 'invalidEscape', text: '\\' };
  if ((c === 'p' || c === 'P') && p[i + 2] === '{') {
    const end = p.indexOf('}', i + 3);
    if (end > 0) return { kind: 'property', text: p.slice(i, end + 1) };
  }
  if (SINGLE_ESCAPES.has(c)) return { kind: 'escape', text: `\\${c}` };
  if (CLASS_ESCAPES.has(c)) return { kind: 'classEscape', text: `\\${c}` };
  return { kind: 'invalidEscape', text: `\\${c}` };
}

/** End offset (exclusive) of the character class starting at `i` (`[`). */
function classEnd(p: string, i: number): number {
  let depth = 0;
  for (let j = i; j < p.length; j++) {
    const c = p[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return p.length;
}

const QUANT = /^(\*|\+|\?|\{\d+(,\d*)?\})/;

export function tokenizeXsdPattern(p: string): XsdToken[] {
  const out: XsdToken[] = [];
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    let tok: { kind: XsdTokenKind; text: string };
    if (c === '\\') tok = escapeAt(p, i);
    else if (c === '[') tok = { kind: 'class', text: p.slice(i, classEnd(p, i)) };
    else if (c === '(' && p[i + 1] === '?') tok = { kind: 'openSpecial', text: p.slice(i, i + (p[i + 2] === '<' && (p[i + 3] === '=' || p[i + 3] === '!') ? 4 : 3)) };
    else if (c === '(') tok = { kind: 'open', text: '(' };
    else if (c === ')') tok = { kind: 'close', text: ')' };
    else if (c === '|') tok = { kind: 'alt', text: '|' };
    else if (c === '.') tok = { kind: 'any', text: '.' };
    else if (c === '^') tok = { kind: 'caret', text: '^' };
    else if (c === '$') tok = { kind: 'dollar', text: '$' };
    else {
      const q = QUANT.exec(p.slice(i));
      if (q) {
        const prev = out[out.length - 1];
        const lazy = prev?.kind === 'quantifier';
        tok = { kind: lazy && (q[0] === '?' || q[0] === '+') ? 'lazy' : 'quantifier', text: q[0] };
      } else {
        tok = { kind: 'char', text: c };
      }
    }
    out.push({ ...tok, start: i });
    i += tok.text.length;
  }
  return out;
}

const CLASS_MEANING: Readonly<Record<string, string>> = {
  '\\d': 'any Unicode decimal digit (not only 0-9)',
  '\\D': 'any character that is not a digit',
  '\\s': 'a space, tab, carriage return or line feed',
  '\\S': 'any character that is not whitespace',
  '\\w': 'any letter or digit in any script (no underscore, unlike most regex dialects)',
  '\\W': 'any character that is not a letter or digit',
  '\\i': 'a character that may start an XML name (letter, _ or :)',
  '\\I': 'a character that may not start an XML name',
  '\\c': 'a character allowed in an XML name',
  '\\C': 'a character not allowed in an XML name',
};

function explainToken(t: XsdToken): string {
  switch (t.kind) {
    case 'char':
      return `the character "${t.text}"`;
    case 'escape':
      return t.text === '\\n' ? 'a line feed' : t.text === '\\r' ? 'a carriage return' : t.text === '\\t' ? 'a tab' : `the character "${t.text.slice(1)}"`;
    case 'classEscape':
      return CLASS_MEANING[t.text] ?? t.text;
    case 'property':
      return `a character in the Unicode category or block ${t.text.slice(3, -1)}${t.text[1] === 'P' ? ' (negated)' : ''}`;
    case 'invalidEscape':
      return `${t.text} is not an XSD escape (not supported)`;
    case 'class':
      return t.text.startsWith('[^') ? `any one character except those in ${t.text}` : `any one character in ${t.text}`;
    case 'any':
      return 'any single character except a line break';
    case 'open':
      return 'start of a group';
    case 'openSpecial':
      return `${t.text} (lookaround, non-capturing or named group) is not supported in XSD`;
    case 'close':
      return 'end of the group';
    case 'alt':
      return 'or';
    case 'quantifier':
      return t.text === '*' ? 'repeated zero or more times' : t.text === '+' ? 'repeated one or more times' : t.text === '?' ? 'optional' : `repeated ${t.text.slice(1, -1).replace(',', ' to ').replace(/ to $/, ' or more')} times`;
    case 'lazy':
      return `${t.text} after a quantifier (lazy / possessive) is not supported in XSD`;
    case 'caret':
      return 'the literal character "^" (XSD patterns are always anchored; ^ is not an anchor)';
    case 'dollar':
      return 'the literal character "$" (XSD patterns are always anchored; $ is not an anchor)';
  }
}

export interface PatternExplanation {
  /** The whole value must match: XSD patterns are implicitly anchored. */
  anchored: true;
  parts: { text: string; meaning: string }[];
  /** Constructs that are not XSD regex. */
  unsupported: string[];
}

/** Explain an XSD pattern token by token, in plain language. */
export function explainXsdPattern(pattern: string): PatternExplanation {
  const tokens = tokenizeXsdPattern(pattern);
  return {
    anchored: true,
    parts: tokens.map((t) => ({ text: t.text, meaning: explainToken(t) })),
    unsupported: tokens.filter((t) => t.kind === 'invalidEscape' || t.kind === 'openSpecial' || t.kind === 'lazy').map((t) => t.text),
  };
}

/** The literal string a pattern stands for, when it has no metacharacters. */
export function literalOf(pattern: string): string | undefined {
  let out = '';
  for (const t of tokenizeXsdPattern(pattern)) {
    if (t.kind === 'char') out += t.text;
    else if (t.kind === 'escape' && !['\\n', '\\r', '\\t'].includes(t.text)) out += t.text.slice(1);
    else return undefined;
  }
  return out;
}
