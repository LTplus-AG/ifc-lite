/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recognise a JS/CSS chunk that failed to load, as opposed to a crash inside a
 * chunk that loaded fine. A leaf, so ./chunk-version-skew.ts can import
 * ./stale-deployment.ts (which also reads it) without a cycle.
 */

/** Vite's wording for arm 1. The only rejection reason it constructs itself. */
const CSS_PRELOAD_FAILURE = /unable to preload css for /i;

/**
 * How each engine words a failed dynamic import. Chromium and Gecko say
 * "Failed to fetch dynamically imported module" / "error loading dynamically
 * imported module"; WebKit says "Importing a module script failed."
 *
 * The `module script` arm covers the OTHER shape a rotated chunk takes: a host
 * that answers a missing asset with its SPA fallback rather than a 404 serves
 * `index.html`, and the browser rejects it as "Failed to load module script:
 * Expected a JavaScript module script but the server responded with a MIME type
 * of text/html". Same skew, no 404 anywhere. ifclite.com does return a real 404
 * for `/assets/*`, but the recovery should not depend on that staying true.
 */
const MODULE_LOAD_FAILURE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script/i;

/** Pull a message out of whatever was thrown, without assuming an Error. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : '';
}

/**
 * True when this event came from Vite's CSS-preload arm, where suppressing the
 * re-throw cannot poison the resolved module (Vite still calls `baseModule()`).
 */
export function isCssPreloadFailure(payload: unknown): boolean {
  return CSS_PRELOAD_FAILURE.test(messageOf(payload));
}

/**
 * True when `err` is a chunk that failed to load, rather than a crash inside a
 * chunk that loaded fine.
 *
 * `ChunkErrorBoundary` wraps whole page subtrees, so it catches every render
 * error under them, not just a rejected `lazy()` import. Without this
 * distinction an ordinary component crash would tell the user their tab was out
 * of date and would be filed under the chunk-skew context in error tracking,
 * mis-grouping a real bug with an auto-recovered one. That is the same
 * mis-classification that made a failed maplibre import look like a dead GPU in
 * issue #1926, so it is worth not reintroducing one file over.
 */
export function isChunkLoadError(err: unknown): boolean {
  const message = messageOf(err);
  return MODULE_LOAD_FAILURE.test(message) || CSS_PRELOAD_FAILURE.test(message);
}
