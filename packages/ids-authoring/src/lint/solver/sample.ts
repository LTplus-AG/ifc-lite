/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sample strings from an XSD pattern.
 *
 * Used only to PROVE that two constraints overlap (a sample that matches
 * both is a witness). A sample that is not a real member of its own
 * pattern is discarded by the caller, so an imprecise generator can only
 * lose witnesses, never invent one. Output is capped, and group nesting is
 * bounded by `MAX_DEPTH`.
 */

import { tokenizeXsdPattern, type XsdToken } from '../rules/xsd-regex.js';

const MAX_SAMPLES = 32;
const MAX_DEPTH = 16;

const CLASS_SAMPLES: Readonly<Record<string, string[]>> = {
  '\\d': ['0', '7'],
  '\\D': ['a', '-'],
  '\\s': [' '],
  '\\S': ['a', '0'],
  '\\w': ['a', 'Z', '5'],
  '\\W': ['-', ' '],
  '\\i': ['a', '_'],
  '\\I': ['0', '-'],
  '\\c': ['a', '0'],
  '\\C': [' ', '/'],
};

const PROBE_CHARS = ['a', 'A', 'z', '0', '5', '9', '_', '-', ' ', '.', '/'];

/** Candidate characters for a bracket expression (verified later by the caller). */
function classSamples(text: string): string[] {
  const body = text.slice(1, -1);
  if (body.startsWith('^')) return PROBE_CHARS;
  const out: string[] = [];
  for (let i = 0; i < body.length && out.length < 4; i++) {
    const c = body[i];
    if (c === '\\') {
      const esc = `\\${body[i + 1] ?? ''}`;
      out.push(...(CLASS_SAMPLES[esc] ?? [body[i + 1] ?? '']).slice(0, 1));
      i++;
    } else if (c !== '-' && c !== '[') {
      out.push(c);
    }
  }
  return out.length ? out : PROBE_CHARS;
}

function cross(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const x of a) for (const y of b) if (out.length < MAX_SAMPLES) out.push(x + y);
  return out;
}

function repeat(atom: string[], q: string): string[] {
  let counts: number[];
  if (q === '*') counts = [0, 1, 2];
  else if (q === '+') counts = [1, 2];
  else if (q === '?') counts = [0, 1];
  else {
    const [lo, hi] = q.slice(1, -1).split(',');
    const n = Number(lo);
    counts = hi === undefined ? [n] : hi === '' ? [n, n + 1] : [n, Math.min(Number(hi), n + 1)];
  }
  const out: string[] = [];
  for (const n of counts) {
    let acc = [''];
    for (let i = 0; i < n && i < 8; i++) acc = cross(acc, atom.slice(0, 3));
    out.push(...acc);
  }
  return out.slice(0, MAX_SAMPLES);
}

interface Cursor {
  tokens: XsdToken[];
  i: number;
}

function parseAlternation(c: Cursor, depth: number): string[] {
  const out: string[] = [];
  out.push(...parseSequence(c, depth));
  while (c.tokens[c.i]?.kind === 'alt') {
    c.i++;
    out.push(...parseSequence(c, depth));
  }
  return out.slice(0, MAX_SAMPLES);
}

function parseSequence(c: Cursor, depth: number): string[] {
  let acc = [''];
  while (c.i < c.tokens.length) {
    const t = c.tokens[c.i];
    if (t.kind === 'alt' || t.kind === 'close') break;
    c.i++;
    let atom: string[];
    if (t.kind === 'open' || t.kind === 'openSpecial') {
      atom = depth >= MAX_DEPTH ? [] : parseAlternation(c, depth + 1);
      if (c.tokens[c.i]?.kind === 'close') c.i++;
    } else if (t.kind === 'char' || t.kind === 'caret' || t.kind === 'dollar') {
      atom = [t.text];
    } else if (t.kind === 'escape') {
      atom = [t.text === '\\n' ? '\n' : t.text === '\\r' ? '\r' : t.text === '\\t' ? '\t' : t.text.slice(1)];
    } else if (t.kind === 'classEscape') {
      atom = CLASS_SAMPLES[t.text] ?? ['a'];
    } else if (t.kind === 'class') {
      atom = classSamples(t.text);
    } else if (t.kind === 'any') {
      atom = ['a', '0'];
    } else {
      atom = PROBE_CHARS.slice(0, 3);
    }
    const q = c.tokens[c.i];
    if (q?.kind === 'quantifier') {
      c.i++;
      if (c.tokens[c.i]?.kind === 'lazy') c.i++;
      atom = repeat(atom, q.text);
    }
    acc = cross(acc, atom);
  }
  return acc;
}

/** Up to 32 candidate members of `pattern` (not all are guaranteed members). */
export function samplePattern(pattern: string): string[] {
  const cursor: Cursor = { tokens: tokenizeXsdPattern(pattern), i: 0 };
  return [...new Set(parseAlternation(cursor, 0))];
}
