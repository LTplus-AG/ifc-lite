/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tells whether vite-plugin-top-level-await re-printed a chunk minified or
 * pretty, for scripts/check-tla-chunk-await.mjs.
 *
 * Every chunk the plugin touches (anything mentioning `__tla`: wrapped chunks,
 * their static importers, entry chunks, workers, dynamic-import rewrites) is
 * re-printed by SWC AFTER the bundler minified it, so its formatting is the
 * plugin's. Upstream 1.6.0 read `build.minify` from the user config, saw
 * `undefined`, and printed all of them pretty: production shipped a 167k-line,
 * 8.2 MB main chunk where a minified one is 4.3 MB (fixed by the configResolved
 * hunk in patches/vite-plugin-top-level-await@1.6.0.patch).
 *
 * WHERE it looks is what makes this robust: only the chunk's PROLOGUE, the code
 * from the start of the chunk up to the first string, template, regex or
 * comment. Nothing quoted can sit there, by definition, so text in a literal
 * (the bundled changelog quoting `let __tla = ` or `let __tla=`) cannot tip the
 * verdict either way. Searching the whole chunk for fingerprints can be fooled
 * in both directions; the prologue cannot.
 *
 * Two pieces are skipped on the way in because they are not the plugin's
 * printing, or are only quotes:
 *   * Vite's `const __vite__mapDeps=...` preload line, prepended after the
 *     plugin ran, always minified;
 *   * leading `import ... from "./x.js";` statements, whose specifier is the
 *     only string in them (kept, with the specifier blanked, since SWC prints
 *     the import clause too: `import { a as b } from` vs `import{a as b}from`).
 * The prologue then normally runs into the plugin's own wrapper
 * (`let __tla=Promise.all([`, `(async()=>{`), so it is the plugin's output
 * that is being judged.
 *
 * SWC's pretty printer puts a space or line break next to punctuation
 * (`let __tla = `, `{\n`, `a, b`); its minifier never does. So a prologue is
 *   pretty   if any punctuation has whitespace beside it;
 *   minified if it has at least MIN_PUNCTUATION punctuation marks and none do;
 *   unknown  otherwise (too short to judge), which the gate treats as a failure
 *            rather than a pass.
 * On the viewer build this splits 103 of 103 `__tla` chunks as pretty before
 * the patch and 103 of 103 as minified after it, with no unknowns; the
 * smallest minified prologue has 13 punctuation marks.
 */

const MAP_DEPS = /^const __vite__mapDeps=[^\n]*\n/;
const LEADING_IMPORT = /^\s*import\s*(?:[\w$*{}\s,]*?\s*from\s*)?(["'])[^"'\n]*\1\s*;?/;
const PUNCTUATION = /[=,{}();:[\]]/g;
const PUNCTUATION_BESIDE_WHITESPACE = /[=,{}();:[\]][ \t\n]|[ \t][=,{}();:[\]]/;
export const MIN_PUNCTUATION = 8;

/** The chunk's leading code, up to the first literal or comment. */
export function prologue(text) {
  let rest = text.replace(MAP_DEPS, '');
  let code = '';
  for (let m = rest.match(LEADING_IMPORT); m; m = rest.match(LEADING_IMPORT)) {
    code += m[0].replace(/(["'])[^"'\n]*\1/, '""');
    rest = rest.slice(m[0].length);
  }
  const literal = rest.search(/['"`/]/);
  return code + (literal === -1 ? rest : rest.slice(0, literal));
}

// The plugin's rewrite of a dynamic import of a wrapped chunk, minified
// (`.then(async m=>{await m.__tla;return m})`) or pretty (spread over lines).
const DYNAMIC_IMPORT_REWRITE = /\.then\(async\s*\(?m\)?\s*=>\s*\{\s*await m\.__tla;\s*return m;?\s*\}\)/;

/**
 * Whether the plugin itself put `__tla` code in this chunk, judged by
 * structure rather than by the substring (which a string literal in an
 * untouched chunk can contain): `__tla` in the prologue (the wrapper
 * declaration, or `__tla as __tla_N` in a leading import), or the plugin's
 * dynamic-import rewrite. The gate adds chunks whose export clause exports
 * `__tla`. On the viewer build these select exactly the 103 chunks that
 * mention `__tla` at all: 101 by prologue, the remaining workers by the
 * dynamic-import rewrite.
 */
export function rewrittenByPlugin(text) {
  return prologue(text).includes('__tla') || DYNAMIC_IMPORT_REWRITE.test(text);
}

/** @returns {'pretty' | 'minified' | 'unknown'} */
export function chunkFormatting(text) {
  const code = prologue(text);
  if (PUNCTUATION_BESIDE_WHITESPACE.test(code)) return 'pretty';
  return (code.match(PUNCTUATION) ?? []).length >= MIN_PUNCTUATION ? 'minified' : 'unknown';
}
