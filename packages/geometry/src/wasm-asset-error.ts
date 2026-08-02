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

/**
 * Discriminates WHY the event fired, so the host does not have to re-derive
 * the classification from the message text (a synthetic worker-script message
 * carries none of the wasm-MIME tokens the strict matcher looks for - re-running
 * the matcher host-side would silently drop exactly the case this exists for).
 *
 * - `wasm-asset`:    the engine binary fetch hit the #1363 MIME/404 signature.
 * - `worker-script`: a Worker script failed to load (empty-message onerror
 *                    from a worker that never posted; stale-deploy 404).
 */
export type WasmAssetUnavailableKind = 'wasm-asset' | 'worker-script';

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
  dispatchAssetUnavailable(messageOf(err), 'wasm-asset');
  return true;
}

function dispatchAssetUnavailable(message: string, kind: WasmAssetUnavailableKind): void {
  const target = domDispatcher();
  if (!target) return;
  try {
    target.dispatchEvent(
      new CustomEvent(WASM_ASSET_UNAVAILABLE_EVENT, { detail: { message, kind } }),
    );
  } catch {
    /* CustomEvent unavailable — best effort, nothing more to do */
  }
}

/**
 * Classify a Worker `onerror` that fired on a worker and broadcast
 * {@link WASM_ASSET_UNAVAILABLE_EVENT} when it is the version-skew signature.
 *
 * When a deploy rotates hashed assets under an open tab, the worker SCRIPT
 * itself can 404 — the host serves the 404 body as `text/plain`, the browser
 * blocks the load ("disallowed MIME type"), and fires `onerror` with an
 * EMPTY/undefined `message` (the MIME detail goes only to the console). The
 * strict wasm matcher above never sees a signature there, so such a load used
 * to die with "Pre-pass worker failed: undefined" instead of recovering.
 *
 * Rules:
 * - the error carries a message → strict wasm matcher only (a genuine
 *   in-worker crash must not trigger a reload; the host reload policy is
 *   additionally sessionStorage-bounded as defence in depth).
 * - empty message AND `receivedAnyMessage` is true → NOT a spawn failure (the
 *   script demonstrably ran); no dispatch.
 * - empty message AND the worker never spoke → the script failed to load;
 *   treat as version skew.
 */
export function notifyIfWorkerScriptUnavailable(
  err: unknown,
  receivedAnyMessage: boolean,
): boolean {
  // Strict string-only extraction: `messageOf`'s `String(err)` fallback would
  // turn an ErrorEvent whose `.message` is undefined into "[object Object]",
  // which would mask exactly the empty-message spawn failure this exists for.
  const msg =
    typeof err === 'string'
      ? err
      : err != null && typeof (err as { message?: unknown }).message === 'string'
        ? ((err as { message: string }).message)
        : '';
  if (msg) return notifyIfWasmAssetUnavailable(msg);
  if (receivedAnyMessage) return false;
  dispatchAssetUnavailable(
    'worker script failed to load (no error message; likely a rotated asset after a redeploy)',
    'worker-script',
  );
  return true;
}
