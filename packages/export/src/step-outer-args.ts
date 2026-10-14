/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { stepStringLiteralEnd } from '@ifc-lite/encoding';

/**
 * Locate the outer STEP argument list of one entity line: the first `(` (nothing
 * is quoted before the type name) and its matching `)`, honouring quoted strings
 * (with the `''` escape) and `/* ... *​/` comments so a literal `)`, `'`, or `(`
 * inside either never shifts the match. Returns `null` for a line without
 * arguments, or one whose span this scan cannot delimit cleanly.
 *
 * Split out of `unit-normalize.ts` (which has no line-count headroom left under
 * `scripts/check-module-size.mjs`) so this scan — shared in spirit with
 * `splitTopLevelStepArguments`'s outer scan in `step-argument-parser.ts` — has
 * somewhere to carry its comment-awareness fix.
 *
 * ISO-10303-21 comment content is unrestricted: a `/* ... *​/` can hold an
 * apostrophe or an unbalanced paren, neither of which is argument-list
 * structure. Before this fix, an apostrophe inside a comment toggled quote
 * state and an unbalanced paren inside one shifted the depth count, so a scan
 * over an otherwise well-formed line could miss the record's real closing `)`
 * and return `null` — which `rescaleEntityLengths` reads as "no arguments to
 * rescale" and silently hands the line back with its length/area/volume data
 * UNSCALED, the same silent-corruption class `splitTopLevelStepArguments` was
 * hardened against for LTplus-AG/ifc-lite#4162.
 */
export function findOuterArgs(line: string): { open: number; close: number } | null {
  const open = line.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) return null; // unterminated comment: nothing past it is trustworthy
      i = end + 1; // loop's i++ lands one past the closing '/'
      continue;
    }
    if (ch === "'") {
      // The shared rule for where a literal ends: `''` and a `\S\'` PAGE
      // operand stay inside it (#7589).
      const end = stepStringLiteralEnd(line, i);
      if (end === -1) return null;
      i = end - 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

/**
 * Apply `edit` to every run of `text` OUTSIDE a STEP string literal, copying
 * each literal verbatim — for the regex rewriters in `unit-normalize.ts`, so a
 * number or typed measure inside a string is never rescaled. Where a literal
 * ends is the shared rule (#7589): a `'(?:[^']|'')*'` regex alternative ended
 * `'Para \S\' 5'` at the PAGE operand and handed ` 5'…` to the rewrite as code.
 * An apostrophe that never closes is left in the code run, as such a regex
 * alternative (failing to match there) left it.
 */
export function mapOutsideStepStrings(text: string, edit: (code: string) => string): string {
  let out = '';
  let from = 0;
  for (let q = text.indexOf("'"); q !== -1; q = text.indexOf("'", from)) {
    const end = stepStringLiteralEnd(text, q);
    if (end === -1) break;
    out += edit(text.slice(from, q)) + text.slice(q, end);
    from = end;
  }
  return out + edit(text.slice(from));
}
