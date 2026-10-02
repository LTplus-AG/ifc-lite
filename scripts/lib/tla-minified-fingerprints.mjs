/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How scripts/check-tla-chunk-await.mjs tells whether vite-plugin-top-level-await
 * re-printed a chunk minified or pretty.
 */

// Every chunk the plugin touched is one it RE-PRINTED with SWC after the
// bundler had already minified it, so its formatting is the plugin's, not
// Vite's. Upstream 1.6.0 read `build.minify` from the user config, where an
// unset value is `undefined`, and so printed all of them (main, store,
// exporters, the workers, ~100 in all) pretty: production shipped a
// 167k-line, 8.2 MB main chunk where a minified one is 4.3 MB (patched in
// patches/vite-plugin-top-level-await@1.6.0.patch).
//
// Scope: every chunk whose text mentions `__tla`, not only the ones that
// export it. Entry chunks (main-*.js) and workers are rewritten too but export
// nothing, and each worker build runs its OWN plugin instance, so a worker
// can regress on its own.
//
// Fingerprints are the plugin's own injected code, which SWC prints with
// spaces and line breaks only when it is not minifying:
//   wrapper   `let __tla = Promise.all(`          vs `let __tla=Promise.all(`
//   importer  `try {\n  return __tla_0;`        vs `try{return __tla_0}`
//   import()  `.then(async (m)=>{\n  await m.__tla;\n` vs `await m.__tla;return m}`
// A line-count heuristic cannot do this: whitespace inside string and
// template literals is indistinguishable from code by counting lines (the
// script templates and the esbuild-wasm chunk are legitimately multi-line).
//
// The scan is over raw text, so the same words could also sit inside a string
// (the bundled changelog, say, quoting this very fix). Two things keep that
// from reading as a pretty-printed chunk without a tokenizer:
//   * each PRETTY form is anchored to its own line, which is where SWC's pretty
//     printer puts it and where a quote in a one-line string cannot;
//   * a chunk is flagged only if it has a pretty form and NO minified form. The
//     plugin prints all of its constructs in one chunk the same way, so a
//     minified chunk always carries the minified form in code (103 of 103 in
//     the viewer; 0 of 103 carry it in the unminified build), and a quoted
//     pretty form in that chunk is outvoted by it.
export const PRETTY_FINGERPRINTS = [
  /^[ \t]*(?:let|const|var) __tla = /m,
  /^[ \t]*try \{[ \t]*\n[ \t]*return __tla_\d+;/m,
  /^[ \t]*await m\.__tla;[ \t]*$/m,
];
export const MINIFIED_FINGERPRINTS = [
  /\b(?:let|const|var) __tla=/,
  /try\{return __tla_\d+\}/,
  /await m\.__tla;return m\}/,
];

/** True when the text carries a pretty-printed form of the plugin's code. */
export const isPretty = (text) => PRETTY_FINGERPRINTS.some((re) => re.test(text));
/** True when the text carries a minified form of the plugin's code. */
export const isMinified = (text) => MINIFIED_FINGERPRINTS.some((re) => re.test(text));
