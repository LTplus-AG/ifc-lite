/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan a STEP argument-list TEXT for `#expressId` references, skipping
 * anything inside a single-quoted string or a `/* ... *​/` comment — `#` is
 * ordinary text there (a `Name` of `'Room #326'` names no entity), not a
 * reference. Shares the quote-doubling and comment rules
 * `step-argument-parser.ts`'s splitters use, so a scan here can't disagree
 * with how the rest of the export path reads the same text — but this is a
 * raw scan of the WHOLE argument-list text, not a split into slots: the
 * caller only ever asks "does this record touch one of these ids", never
 * which slot.
 */
import { stepStringLiteralEnd } from '@ifc-lite/encoding';
import { skipStepComment } from './step-comment-skip.js';

/**
 * True as soon as any `#id` found in `attrsRaw` is a member of `ids`.
 * Short-circuits rather than collecting every reference the text contains.
 */
export function referencesAnyExpressId(attrsRaw: string, ids: ReadonlySet<number>): boolean {
  if (ids.size === 0) return false;
  for (let i = 0; i < attrsRaw.length; i++) {
    const ch = attrsRaw[i];
    if (ch === '/' && attrsRaw[i + 1] === '*') {
      i = skipStepComment(attrsRaw, i) - 1;
      continue;
    }
    if (ch === '\'') {
      // The shared rule for where a literal ends (#7589); unterminated: the rest.
      const end = stepStringLiteralEnd(attrsRaw, i);
      if (end === -1) return false;
      i = end - 1;
      continue;
    }
    if (ch === '#') {
      let j = i + 1;
      let digits = '';
      while (j < attrsRaw.length && attrsRaw[j] >= '0' && attrsRaw[j] <= '9') {
        digits += attrsRaw[j];
        j++;
      }
      if (digits.length > 0 && ids.has(Number(digits))) return true;
      i = j - 1;
    }
  }
  return false;
}

/**
 * Byte twin of `stepStringLiteralEnd` (`@ifc-lite/encoding`) for walkers that
 * scan a source buffer without decoding it (#7589): the index just past the
 * apostrophe closing the literal that opens at `open`, or `-1` when it does not
 * close before `end`. Same rule, tested in the same order: a `\S\` PAGE
 * operand is text, then `''` is an escaped quote.
 */
export function stepBytesLiteralEnd(bytes: Uint8Array, open: number, end: number): number {
  for (let p = open + 1; p < end; p++) {
    if (bytes[p] !== 0x27) continue;
    if (p >= 3 && bytes[p - 1] === 0x5c && bytes[p - 2] === 0x53 && bytes[p - 3] === 0x5c) continue;
    if (p + 1 < end && bytes[p + 1] === 0x27) { p++; continue; }
    return p + 1;
  }
  return -1;
}
