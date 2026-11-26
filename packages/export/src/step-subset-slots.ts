/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Reading one STEP attribute slot with comments as trivia. */

import { stepStringLiteralEnd } from '@ifc-lite/encoding';
import { skipStepComment } from './step-comment-skip.js';
import { SINGLE_REF_RE } from './step-subset-relations.js';

/**
 * The single reference an attribute slot holds (`#42`, comments and
 * whitespace around it allowed), or undefined when the slot is anything else.
 */
export function slotRef(arg: string | undefined): number | undefined {
  if (arg === undefined) return undefined;
  const bare = withoutComments(arg).trim();
  const m = SINGLE_REF_RE.exec(bare);
  return m ? Number(m[1]) : undefined;
}

/** `text` with every `/* ... *\/` comment outside string literals removed. */
export function withoutComments(text: string): string {
  if (!text.includes('/*')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '/' && text[i + 1] === '*') {
      i = skipStepComment(text, i) - 1;
      out += ' ';
    } else if (char === "'") {
      const end = stepStringLiteralEnd(text, i);
      if (end < 0) return out + text.slice(i);
      out += text.slice(i, end);
      i = end - 1;
    } else {
      out += char;
    }
  }
  return out;
}
