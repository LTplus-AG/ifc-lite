/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Comment stripping for the handful of tests that still assert on SOURCE TEXT
 * (`scripts/source-text-assertion-allowlist.txt`).
 *
 * Every such test has the same hazard: the string it looks for can be
 * satisfied by prose that merely *quotes* the call it is supposed to be
 * pinning, so the real call can be deleted while the assertion stays green.
 * `SearchModal.filter.wiring.test.ts` caught exactly that.
 *
 * This existed in two spellings, and they did not agree — the classic "two
 * paths that must agree" defect. `aggregation.test.ts` stripped block comments
 * and line comments; `modelLoadedGeometryProps.test.ts` dropped only lines
 * whose `trimStart()` began with `//`, which leaves a TRAILING comment on a
 * code line intact. Demonstrated in the #2393 self-review: delete the real
 * `...buildModelLoadedGeometryProps({...})` spread from `useIfcLoader.ts`,
 * append one trailing comment quoting it to the line above, and all four
 * argument-span assertions passed while the emitted `ifc_model_loaded` carried
 * none of the fields. `useIfcLoader.ts` also has 13 block comments, one of them
 * nine lines below the protected declaration.
 *
 * ## What this withstands, and what it does not
 *
 * Handled: block comments (slash-star … star-slash, JSDoc included), whole-line
 * `//` comments, trailing `//` comments, and `//` sequences that are NOT
 * comments because they sit inside a string or template literal — the `//` of
 * `'https://…'` most of all, which a naive `indexOf('//')` would truncate,
 * silently deleting the rest of a real line of code and weakening the
 * assertion in the other direction.
 *
 * NOT handled, deliberately: this is a lexical scanner, not a parser. Regex
 * literals containing quotes (`/["']/`) can desynchronise the string tracker,
 * and JSX text is passed through as ordinary source. It is strictly stronger
 * than either predecessor and enough for the assertions it guards; a test that
 * needs a real parse should use the TypeScript AST the way
 * `toolbar-parity.test.ts` does.
 *
 * Do NOT reach for this to make a NEW source-text assertion possible. The
 * allowlist only ratchets down; a behavioural test is the answer.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  // Which quote character, if any, we are currently inside.
  let quote: '"' | "'" | '`' | null = null;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        // Escape: copy the escaped character verbatim so `\'` cannot close.
        if (i + 1 < source.length) out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      // Block comment: replace with a newline for each line it spanned, so
      // line-oriented assertions and error messages keep their line numbers.
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let j = i; j < stop; j++) if (source[j] === '\n') out += '\n';
      i = stop;
      continue;
    }

    if (ch === '/' && next === '/') {
      // Line comment — whether it starts the line or trails real code.
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
    i++;
  }

  return out;
}
