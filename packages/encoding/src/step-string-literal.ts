/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one decoder for the INNER TEXT of an ISO 10303-21 string literal.
 *
 * A STEP string literal carries two independent escape layers, and a reader
 * that resolves only one of them is wrong on real files:
 *
 *   1. the two lexical DOUBLINGS, `''` for a quote and `\\` for a reverse
 *      solidus, which the tokenizer's consumers strip along with the outer
 *      quotes;
 *   2. the backslash DIRECTIVES — `\X2\HHHH\X0\`, `\X4\…\X0\`, `\X\HH`, `\S\x`,
 *      `\Px\` — which carry every non-ASCII character an IFC file may hold, and
 *      which {@link decodeIfcString} resolves.
 *
 * Hand-rolled `\\`->`\` regexes have been written twice in this repo and were
 * wrong the same way both times: they leave a directive untouched, so
 * `\X2\00FC\X0\` reads back as the literal nine characters instead of `ü`
 * (`packages/parser/src/source-header.ts` in #2486, `parseStepValue` in
 * `@ifc-lite/data` in #2490). Hence one exported implementation rather than a
 * doc comment asking the next reader to be careful.
 *
 * ## Why the two layers cannot be resolved by two independent passes
 *
 * A naive split at every doubled backslash consumes a DIRECTIVE'S closing
 * backslash whenever the directive is immediately followed by an escaped
 * backslash: `\X2\00FC\X0\` + `\\` ends in three backslashes and the split eats
 * the first two, leaving an unterminated `\X2\` that never decodes. So this
 * scans left to right and gives directives precedence — each whole directive
 * span moves into the pending segment atomically, `\\` is a literal backslash
 * only OUTSIDE a span, and the segments are handed to {@link decodeIfcString}
 * untouched.
 *
 * Giving directives precedence is also what keeps ESCAPED directive text
 * literal: `\\X2\\00FC\\X0\\` means the characters `\X2\00FC\X0\` and must not
 * decode to `ü`. The scan sees `\\` first at every step there, so it never
 * forms a directive span.
 *
 * ## The writer's half of the contract
 *
 * {@link decodeIfcString} deliberately PRESERVES an unknown escape (it cannot
 * collapse `\\` itself without ambiguity), which is why the pair handling lives
 * here. A writer paired with this reader may either emit non-ASCII raw (UTF-8,
 * no backslashes to double) or emit `\X2\` directives — both round-trip — but
 * it must double a literal reverse solidus, or this reader will read one as the
 * start of a directive.
 */

import { decodeIfcString } from './ifc-string.js';

/**
 * Decode the inner text of a STEP string literal (outer `'…'` already
 * stripped) to its Unicode value.
 *
 * @param inner the literal's contents, still carrying `''` / `\\` doublings and
 *   any backslash directives.
 */
export function decodeStepStringLiteral(inner: string): string {
  const value = inner.replace(/''/g, "'");
  let out = '';
  let seg = ''; // pending directive-bearing text, flushed through decodeIfcString
  let i = 0;
  while (i < value.length) {
    if (value[i] === '\\') {
      // Whole directive spans move into `seg` atomically so their own
      // backslashes (terminators, \S\ operands) never match the pair escape.
      if (value.startsWith('\\X2\\', i) || value.startsWith('\\X4\\', i)) {
        const end = value.indexOf('\\X0\\', i + 4);
        if (end !== -1) {
          seg += value.slice(i, end + 4);
          i = end + 4;
          continue;
        }
      } else if (value.startsWith('\\S\\', i) && i + 3 < value.length) {
        seg += value.slice(i, i + 4); // \S\ + operand char (may itself be '\')
        i += 4;
        continue;
      } else if (value.startsWith('\\X\\', i)) {
        seg += value.slice(i, i + 5); // \X\ + two hex digits
        i += 5;
        continue;
      } else if (/^\\P[A-Z]\\/.test(value.slice(i, i + 4))) {
        seg += value.slice(i, i + 4);
        i += 4;
        continue;
      }
      if (value[i + 1] === '\\') {
        out += decodeIfcString(seg) + '\\';
        seg = '';
        i += 2;
        continue;
      }
    }
    seg += value[i];
    i += 1;
  }
  return out + decodeIfcString(seg);
}
