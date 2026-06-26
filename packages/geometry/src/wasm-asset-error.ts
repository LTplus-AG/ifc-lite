/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Detect and broadcast the "stale deployment" WASM-asset signature (#1363).
 *
 * A long-lived viewer tab holds JS that references a content-hashed
 * `ifc-lite_bg-<hash>.wasm`. A later production deploy rotates that asset, so
 * the tab's now-lazy fetch 404s. The static host serves the 404 body as
 * `text/plain`, so `WebAssembly.instantiateStreaming` rejects with
 *
 *   TypeError: WebAssembly: Response has unsupported MIME type
 *              'text/plain; charset=utf-8' expected 'application/wasm'
 *
 * and wasm-bindgen re-raises it (its built-in MIME fallback only triggers for
 * an *ok* response — a 404 is `!ok`, so the original TypeError propagates).
 *
 * Unlike a transient blip (handled by {@link initWasmWithRetry} with a
 * same-URL retry), a rotated asset is gone for good: refetching the same hashed
 * URL can never recover it. The only remedy is reloading the document so the
 * browser pulls the current deployment's HTML and its fresh asset URLs.
 *
 * Detection lives here as a pure, unit-testable predicate; the host app owns
 * the reload policy and subscribes to {@link WASM_ASSET_UNAVAILABLE_EVENT}.
 * This library never reloads the page on its own.
 */

/**
 * Dispatched on `globalThis` when a WASM engine binary is unreachable because
 * the deployment rotated assets under a still-open tab. `detail.message`
 * carries the originating error text. Hosts that opt in (the viewer) reload
 * once to pick up the current deployment.
 */
export const WASM_ASSET_UNAVAILABLE_EVENT = 'ifclite:wasm-asset-unavailable';

function messageOf(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

/**
 * True when an error looks like a content-hashed WASM binary that 404'd / was
 * served with the wrong MIME type because the deployment rotated under a
 * still-open tab. Matches the browser-specific phrasings:
 *
 *  - Firefox:  `Response has unsupported MIME type 'text/plain…' expected 'application/wasm'`
 *  - Chromium: `Incorrect response MIME type. Expected 'application/wasm'.`
 *  - status-first variants: a `WebAssembly` compile that failed because the
 *    response was a non-OK HTTP status (the asset is simply gone).
 *  - the dynamic-import sibling: `Failed to fetch dynamically imported
 *    module … .wasm`.
 *
 * The message may be wrapped (e.g. `Geometry worker error: <original>`), so the
 * match is a substring test rather than an exact compare. Genuine
 * module-validation failures (`CompileError`, bad magic word) are intentionally
 * NOT matched — those are real corruption, not version skew, and a reload would
 * loop without fixing them.
 */
export function isWasmAssetUnavailableError(err: unknown): boolean {
  const msg = messageOf(err);
  if (!msg) return false;

  // Never treat a genuine corrupt-module / validation failure as version skew.
  if (/compileerror|magic (?:word|number)|invalid (?:wasm|module)|module is not a valid/i.test(msg)) {
    return false;
  }

  // Wrong-MIME-for-wasm — the #1363 signature. Both the "expected
  // application/wasm" and "unsupported/incorrect MIME type" phrasings mean the
  // bytes were not the engine binary, i.e. a 404 / HTML / text page stood in
  // its place.
  if (/application\/wasm/i.test(msg) && /mime|content[- ]?type|unsupported|incorrect|expected/i.test(msg)) {
    return true;
  }

  // A WebAssembly fetch/compile that failed on a non-OK HTTP response — the
  // hashed asset is missing after a redeploy.
  if (
    /wasm|webassembly/i.test(msg) &&
    /HTTP status code is not ok|status code (?:4\d\d|5\d\d)|status (?:4\d\d|5\d\d)/i.test(msg)
  ) {
    return true;
  }

  // The dynamic-import wrapper around a now-missing `.wasm` URL.
  if (
    /\.wasm/i.test(msg) &&
    /dynamically imported module|importing a module script failed|error loading dynamically imported/i.test(msg)
  ) {
    return true;
  }

  return false;
}

interface DomDispatcher {
  dispatchEvent: (event: Event) => boolean;
}

function domDispatcher(): DomDispatcher | null {
  const g = globalThis as unknown as Partial<DomDispatcher> & { CustomEvent?: unknown };
  return typeof g.dispatchEvent === 'function' && typeof g.CustomEvent === 'function'
    ? (g as DomDispatcher)
    : null;
}

/**
 * If `err` is the version-skew signature, broadcast
 * {@link WASM_ASSET_UNAVAILABLE_EVENT} on `globalThis` so an opted-in host can
 * reload. Returns whether the error matched. No-op (returns the match result
 * but dispatches nothing) in non-DOM hosts such as Node. The library never
 * reloads the page itself.
 */
export function notifyIfWasmAssetUnavailable(err: unknown): boolean {
  if (!isWasmAssetUnavailableError(err)) return false;
  const target = domDispatcher();
  if (target) {
    try {
      target.dispatchEvent(
        new CustomEvent(WASM_ASSET_UNAVAILABLE_EVENT, { detail: { message: messageOf(err) } }),
      );
    } catch {
      /* CustomEvent unavailable — best effort, nothing more to do */
    }
  }
  return true;
}
