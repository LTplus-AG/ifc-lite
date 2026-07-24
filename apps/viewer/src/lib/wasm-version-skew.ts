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

function markReloaded(now: number): boolean {
  try {
    sessionStorage.setItem(RELOAD_TS_KEY, String(now));
    return true;
  } catch {
    // sessionStorage blocked (private mode / sandboxed embed without
    // allow-same-origin / "block all cookies"). If we cannot RECORD a reload
    // we must not PERFORM one: a permanent failure (CSP-blocked worker, proxy
    // rewriting assets) would otherwise reload on every occurrence with no
    // debounce at all. Mirrors the vite:preloadError policy in main.tsx.
    return false;
  }
}

export interface VersionSkewDeps {
  now: () => number;
  reload: () => void;
  hasRecentReload: (now: number) => boolean;
  /** Persist the reload attempt. Returning false VETOES the reload (storage unavailable). */
  rememberReload: (now: number) => boolean;
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
  return attemptBoundedReload(deps);
}

/**
 * Reload for an event the geometry library ALREADY classified as version skew
 * (`detail.kind === 'worker-script'`): a worker script that failed to load
 * fires `onerror` with an EMPTY message, so re-running the message matcher
 * here would reject exactly the case the event exists for. The classification
 * is trusted; safety comes from the bounded reload policy instead — at most
 * one reload per debounce window, and none at all when the attempt cannot be
 * recorded. A rare false positive (a worker OOM-killed before its first post,
 * a CSP-blocked spawn) therefore costs one debounced reload, not a loop.
 */
export function recoverFromWorkerScriptSkew(deps: VersionSkewDeps = defaultDeps): boolean {
  return attemptBoundedReload(deps);
}

function attemptBoundedReload(deps: VersionSkewDeps): boolean {
  const now = deps.now();
  if (deps.hasRecentReload(now)) return false;
  if (!deps.rememberReload(now)) return false;
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
    const detail = (event as CustomEvent<{ message?: string; kind?: string }>).detail;
    if (detail?.kind === 'worker-script') {
      recoverFromWorkerScriptSkew();
      return;
    }
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

// ── Telemetry noise suppression ──────────────────────────────────────────────
// A version-skew wasm error is AUTO-RECOVERED: the handlers above reload the tab
// onto fresh assets and the engine loads. But the exception is captured (by
// PostHog autocapture, or our own captureException in the load catch) BEFORE the
// reload navigates away, so a 100%-recovered condition still files an
// `$exception` — and every rotated hash mints more. The result is a permanently
// growing error-tracking issue for a class of failure the user never actually
// experiences.
//
// We drop that noise WITHOUT hiding a genuinely-stuck deploy (new assets also
// unreachable — CSP-blocked worker, a proxy rewriting every wasm to text/plain).
// The distinguisher is recurrence: a recovered skew fires once or twice then is
// gone; a genuine block keeps firing because the reload never fixes it. So we
// suppress only the first few skew exceptions within a short window and let the
// rest surface. The count decays, so a genuinely-new skew later in a long
// session (a second deploy) gets a fresh suppression budget rather than being
// mistaken for a persistent block.
const SKEW_NOISE_COUNT_KEY = 'ifclite:wasm-skew-noise-count';
const SKEW_NOISE_TS_KEY = 'ifclite:wasm-skew-noise-ts';
// Drop this many recovered-noise hits before letting a persistent block through.
// The reload round-trip produces the straggler or two we absorb here; a real
// block keeps coming and surfaces on the next hit.
const SKEW_NOISE_SUPPRESS_MAX = 3;
// Reset the counter when the last skew was longer ago than this, so an unrelated
// later skew is judged on its own recurrence, not a stale count.
const SKEW_NOISE_RESET_MS = 5 * 60_000;

/** Extract the first exception message string from a PostHog `$exception` event. */
function exceptionMessageOf(
  event: { event?: string; properties?: Record<string, unknown> } | null,
): string | undefined {
  if (!event || event.event !== '$exception' || !event.properties) return undefined;
  const list = event.properties.$exception_list;
  if (Array.isArray(list)) {
    for (const e of list) {
      const v = (e as { value?: unknown })?.value;
      if (typeof v === 'string' && v) return v;
    }
  }
  const values = event.properties.$exception_values;
  if (Array.isArray(values) && typeof values[0] === 'string') return values[0];
  return undefined;
}

/** Storage-backed decaying counter of recent skew-noise exceptions. Injectable for tests. */
export interface SkewNoiseDeps {
  now: () => number;
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
}

const defaultNoiseDeps: SkewNoiseDeps = {
  now: () => Date.now(),
  read: (k) => {
    try { return sessionStorage.getItem(k); } catch { return null; }
  },
  write: (k, v) => {
    try { sessionStorage.setItem(k, v); } catch { /* blocked storage — see below */ }
  },
};

/**
 * Decide whether a captured PostHog event is an auto-recovered wasm version-skew
 * exception that should be dropped as noise. Returns `true` to DROP.
 *
 * Safe defaults: a non-skew event is never dropped; if the recurrence counter
 * cannot be persisted (blocked storage) we do NOT suppress — better a little
 * noise than hiding a failure, and a storage-blocked tab never auto-reloads
 * anyway (it surfaces the error for a manual reload), so keeping it is correct.
 */
export function shouldSuppressWasmSkewNoise(
  event: { event?: string; properties?: Record<string, unknown> } | null,
  deps: SkewNoiseDeps = defaultNoiseDeps,
): boolean {
  const message = exceptionMessageOf(event);
  if (message === undefined || !isWasmAssetUnavailableError(message)) return false;

  const now = deps.now();
  const lastTs = Number(deps.read(SKEW_NOISE_TS_KEY));
  const decayed = !Number.isFinite(lastTs) || now - lastTs > SKEW_NOISE_RESET_MS;
  const prior = decayed ? 0 : Number(deps.read(SKEW_NOISE_COUNT_KEY)) || 0;
  const count = prior + 1;

  // Persist the running count + timestamp, then confirm the write actually
  // stuck. A blocked store (private mode / sandboxed embed) would otherwise
  // pin the count at 1 forever and suppress EVERY skew exception — hiding a
  // genuine persistent block. If we can't bound the count across events we must
  // not suppress: a storage-blocked tab surfaces the error for a manual reload
  // (it never auto-reloads either, per the reload veto above), so keeping the
  // exception is the correct, consistent default.
  deps.write(SKEW_NOISE_COUNT_KEY, String(count));
  deps.write(SKEW_NOISE_TS_KEY, String(now));
  if (deps.read(SKEW_NOISE_COUNT_KEY) !== String(count)) return false;

  return count <= SKEW_NOISE_SUPPRESS_MAX;
}

/** Test-only: clear the noise counter keys via the given deps. */
export function __resetWasmSkewNoiseForTests(deps: SkewNoiseDeps = defaultNoiseDeps): void {
  deps.write(SKEW_NOISE_COUNT_KEY, '0');
  deps.write(SKEW_NOISE_TS_KEY, '0');
}
