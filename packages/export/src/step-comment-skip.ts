/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { stepStringLiteralEnd } from '@ifc-lite/encoding';

/**
 * Skip a comment-delimiter-bounded region atomically, starting at the index
 * of its opening `/` marker (caller has already checked `text[i] === '/' &&
 * text[i + 1] === '*'`). Returns the index one past the region's end — the
 * matching close marker, or end-of-text when unterminated — so its content
 * (a comma, an unbalanced paren, an odd number of `'`) is skipped as one
 * unit rather than read as argument-list structure. Shared by both
 * `step-argument-parser.ts` splitters so the skip rule can't drift between
 * them again (#4227: `splitTopLevelListItems` shipped with no comment handling
 * at all while `splitTopLevelStepArguments` had this same logic inline).
 */
export function skipStepComment(text: string, i: number): number {
  const end = text.indexOf('*/', i + 2);
  return end === -1 ? text.length : end + 2;
}

/** `value` with each `/* ... *\/` comment read as a space, trimmed. Literals and comments
 *  end by the shared rules; an unclosed one runs to the end. Twin of Rust
 *  `step_slot::without_comments` (rust/export/src/step_slot.rs). */
export function withoutComments(value: string): string {
  let out = '';
  let kept = 0;
  for (let i = 0; i < value.length;) {
    if (value[i] === "'") {
      const end = stepStringLiteralEnd(value, i);
      i = end === -1 ? value.length : end;
    } else if (value.startsWith('/*', i)) {
      out += `${value.slice(kept, i)} `; // a space keeps the tokens the comment parted apart
      i = kept = skipStepComment(value, i);
    } else i++;
  }
  return (out + value.slice(kept)).trim();
}

/** A slot that carries information: not `$`, `*` or empty once comments go
 *  (#10779). Twin of Rust `schema_convert::holds_value`
 *  (rust/export/src/schema_convert.rs). */
export function holdsValue(slot: string): boolean {
  const v = slot.includes('/*') ? withoutComments(slot) : slot.trim();
  return v !== '' && v !== '$' && v !== '*';
}
