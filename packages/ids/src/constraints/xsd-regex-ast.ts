/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A small parser for XSD regular expressions (XML Schema Part 2,
 * Appendix F), producing the tree the example generator walks. It does
 * not decide what a pattern MEANS: every character class keeps its source
 * text, and membership is answered by the same translator the checker
 * uses (`translateXsdRegex`), so the generator can never disagree with
 * validation about a class.
 *
 * Grammar: regExp ::= branch ('|' branch)*; branch ::= piece*;
 * piece ::= atom quantifier?; atom ::= char | charClass | '(' regExp ')'.
 * XSD has no anchors, lookaround or back-references.
 */

export type XsdNode =
  | { type: 'alt'; branches: XsdNode[][] }
  | { type: 'char'; value: string }
  /** A class (`[…]`, `\d`, `\p{Lu}`, `.`) by its XSD source text. */
  | { type: 'class'; source: string }
  | { type: 'group'; body: XsdNode }
  | { type: 'repeat'; node: XsdNode; min: number; max: number };

export class XsdParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XsdParseError';
  }
}

const SINGLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t' };
const CLASS_ESCAPES = new Set(['s', 'S', 'i', 'I', 'c', 'C', 'd', 'D', 'w', 'W']);
const META = new Set(['\\', '|', '.', '-', '^', '?', '*', '+', '{', '}', '(', ')', '[', ']']);

export function parseXsdRegex(pattern: string): XsdNode {
  let i = 0;

  const classEnd = (start: number): number => {
    // `start` holds `[`; returns the index just past the matching `]`
    // (nested `-[…]` subtraction included).
    let j = start + 1;
    if (pattern[j] === '^') j++;
    let first = true;
    while (j < pattern.length) {
      const c = pattern[j];
      if (c === '\\') {
        const prop = /^\\[pP]\{[^}]*\}/.exec(pattern.slice(j));
        j += prop ? prop[0].length : 2;
      } else if (c === '-' && pattern[j + 1] === '[') {
        j = classEnd(j + 1);
        if (pattern[j] !== ']') throw new XsdParseError(`a subtraction must end its class at ${j}`);
        return j + 1;
      } else if (c === ']' && !first) {
        return j + 1;
      } else {
        j++;
      }
      first = false;
    }
    throw new XsdParseError(`unterminated character class at ${start}`);
  };

  const atom = (): XsdNode => {
    const c = pattern[i];
    if (c === '(') {
      i++;
      const body = alt();
      if (pattern[i] !== ')') throw new XsdParseError(`missing ) at ${i}`);
      i++;
      return { type: 'group', body };
    }
    if (c === '[') {
      const end = classEnd(i);
      const source = pattern.slice(i, end);
      i = end;
      return { type: 'class', source };
    }
    if (c === '.') {
      i++;
      return { type: 'class', source: '.' };
    }
    if (c === '\\') {
      const n = pattern[i + 1];
      if (n === undefined) throw new XsdParseError('dangling \\ at the end');
      if (n === 'p' || n === 'P') {
        const m = /^\\[pP]\{[^}]*\}/.exec(pattern.slice(i));
        if (!m) throw new XsdParseError(`malformed \\${n}{…} at ${i}`);
        i += m[0].length;
        return { type: 'class', source: m[0] };
      }
      i += 2;
      if (CLASS_ESCAPES.has(n)) return { type: 'class', source: `\\${n}` };
      if (n in SINGLE_ESCAPES) return { type: 'char', value: SINGLE_ESCAPES[n] };
      if (META.has(n)) return { type: 'char', value: n };
      // Not a valid XSD escape, but checkers (and ours) read an escaped
      // punctuation character as itself (`\/` occurs in real IDS files).
      if (!/[\p{L}\p{N}]/u.test(n)) return { type: 'char', value: n };
      throw new XsdParseError(`unknown escape \\${n}`);
    }
    if (c === ')' || c === '|' || c === '?' || c === '*' || c === '+' || c === '{') {
      throw new XsdParseError(`unexpected ${c} at ${i}`);
    }
    const cp = pattern.codePointAt(i) as number;
    const value = String.fromCodePoint(cp);
    i += value.length;
    return { type: 'char', value };
  };

  const quantified = (node: XsdNode): XsdNode => {
    const c = pattern[i];
    if (c === '?' || c === '*' || c === '+') {
      i++;
      return { type: 'repeat', node, min: c === '+' ? 1 : 0, max: c === '?' ? 1 : Infinity };
    }
    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (!m) throw new XsdParseError(`malformed quantifier at ${i}`);
      i += m[0].length;
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      if (max < min) throw new XsdParseError(`quantifier {${min},${max}} has max < min`);
      return { type: 'repeat', node, min, max };
    }
    return node;
  };

  const branch = (): XsdNode[] => {
    const items: XsdNode[] = [];
    while (i < pattern.length && pattern[i] !== '|' && pattern[i] !== ')') items.push(quantified(atom()));
    return items;
  };

  const alt = (): XsdNode => {
    const branches = [branch()];
    while (pattern[i] === '|') {
      i++;
      branches.push(branch());
    }
    return { type: 'alt', branches };
  };

  const root = alt();
  if (i !== pattern.length) throw new XsdParseError(`unexpected ${pattern[i]} at ${i}`);
  return root;
}
