/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { stepStringLiteralEnd } from './step-string-end.js';

/**
 * Split STEP parameter text at commas that are not inside parentheses or
 * brackets, a string literal, or a `/* ... *\/` comment (#7785).
 *
 * The one TS splitter for text that is not a whole record. A literal ends by
 * `stepStringLiteralEnd` (`''` and a `\S\'` PAGE operand stay inside, #7589),
 * and a comment is skipped atomically, so a `,`, `(`, `)` or `'` in either is
 * not structure. An unterminated literal or comment runs to the end of the
 * text. Each comment collapses to one space so the tokens around it are not
 * spliced (`5/* c *\/6` is not `56`). Items are trimmed; the last item is
 * always returned, even when empty (callers decide whether a trailing empty
 * item is a value).
 */
export function splitStepTopLevel(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      const close = stepStringLiteralEnd(text, i);
      const stop = close < 0 ? text.length : close;
      current += text.slice(i, stop);
      i = stop - 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      current += ' ';
      i = (close < 0 ? text.length : close + 2) - 1;
    } else if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      current += ch;
    }
  }
  items.push(current.trim());
  return items;
}
