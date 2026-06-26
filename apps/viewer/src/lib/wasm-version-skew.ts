/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recover from "deployment skew": a tab that has been open across a production
 * deploy holds JS referencing a content-hashed `ifc-lite_bg-<hash>.wasm` that
 * the new deploy rotated away. The lazy fetch 404s (served as `text/plain`), so
 * `WebAssembly.instantiateStreaming` throws
 * `unsupported MIME type 'text/plain' … expected 'application/wasm'` and the
 * engine never initializes (issue #1363).
 *
 * The asset is gone for good, so a same-URL retry can't help — the only fix is
 * to reload the document so the browser pulls the current deployment's HTML and
 * its fresh asset URLs. The `@ifc-lite/geometry` engine broadcasts
 * {@link WASM_ASSET_UNAVAILABLE_EVENT} when it hits this; we also watch the
 * global error channels as a backstop for any wasm asset (parser, direct
 * imports) that bubbles unhandled.
 *
 * The reload is debounced per tab so a genuinely broken deploy (where the new
 * assets are also unreachable) can't spin in a reload loop.
 */

import {
  isWasmAssetUnavailableError,
  WASM_ASSET_UNAVAILABLE_EVENT,
} from '@ifc-lite/geometry';

/** sessionStorage key holding the epoch-ms of the last skew-triggered reload. */
const RELOAD_TS_KEY = 'ifclite:wasm-skew-reload-ts';

/**
 * Minimum gap between skew reloads in one tab. A successful reload fixes the
 * skew well within this window; a still-broken deploy is therefore allowed to
 * surface its error instead of looping. After the window elapses, a genuinely
 * new deploy later in a long session can recover again.
 */
const RELOAD_DEBOUNCE_MS = 60_000;

function recentlyReloaded(now: number): boolean {
  try {
    const raw = sessionStorage.getItem(RELOAD_TS_KEY);
    if (raw == null) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && now - ts < RELOAD_DEBOUNCE_MS;
  } catch {
    return false;
  }
}

function markReloaded(now: number): void {
  try {
    sessionStorage.setItem(RELOAD_TS_KEY, String(now));
  } catch {
    /* sessionStorage blocked (private mode / disabled) — still reload once */
  }
}

export interface VersionSkewDeps {
  now: () => number;
  reload: () => void;
  hasRecentReload: (now: number) => boolean;
  rememberReload: (now: number) => void;
}

const defaultDeps: VersionSkewDeps = {
  now: () => Date.now(),
  reload: () => window.location.reload(),
  hasRecentReload: recentlyReloaded,
  rememberReload: markReloaded,
};

/**
 * If `err` carries the stale-deployment WASM signature, reload the page once
 * (debounced per tab). Returns `true` when a reload was triggered. Exposed with
 * injectable deps for unit testing; production callers omit `deps`.
 */
export function recoverFromWasmVersionSkew(
  err: unknown,
  deps: VersionSkewDeps = defaultDeps,
): boolean {
  if (!isWasmAssetUnavailableError(err)) return false;
  const now = deps.now();
  if (deps.hasRecentReload(now)) return false;
  deps.rememberReload(now);
  deps.reload();
  return true;
}

let installed = false;

/**
 * Wire the event-driven + global-backstop recovery. Idempotent; call once at
 * app boot. No-op outside a browser window (SSR / tests without a DOM).
 */
export function installWasmVersionSkewRecovery(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // Explicit signal from the geometry engine's init choke points. This covers
  // the common case where the app caught + reported the failure rather than
  // letting it bubble to the global handlers below.
  window.addEventListener(WASM_ASSET_UNAVAILABLE_EVENT, (event) => {
    const detail = (event as CustomEvent<{ message?: string }>).detail;
    recoverFromWasmVersionSkew(detail?.message ?? '');
  });

  // Backstop for any wasm asset error that bubbles unhandled — parser wasm,
  // direct `@ifc-lite/wasm` imports, third-party wasm, etc.
  window.addEventListener('unhandledrejection', (event) => {
    recoverFromWasmVersionSkew(event.reason);
  });
  window.addEventListener('error', (event) => {
    recoverFromWasmVersionSkew(event.error ?? event.message);
  });
}

/** Test-only: reset the install guard so the module can be re-wired. */
export function __resetWasmVersionSkewForTests(): void {
  installed = false;
}
