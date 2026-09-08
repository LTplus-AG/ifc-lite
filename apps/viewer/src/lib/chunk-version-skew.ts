/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recover from JS/CSS "deployment skew": a tab open across a production deploy
 * holds an entry chunk whose lazy imports point at content-hashed asset URLs the
 * new deploy rotated away. The lazy `import()` then 404s and Vite dispatches
 * `vite:preloadError`. The asset is gone for good, so the only fix is to reload
 * the document and pull the current deployment's HTML plus its fresh asset URLs.
 *
 * This is the JS sibling of ./wasm-version-skew.ts, which does the same for the
 * `ifc-lite_bg.wasm` engine binary (fetched inside a worker, so invisible to
 * `vite:preloadError`).
 *
 * ## Why `preventDefault()` is not a free "we own the recovery" switch
 *
 * Vite's generated preload helper calls its error handler from TWO places:
 *
 * ```js
 * function handlePreloadError(err) {
 *   const e = new Event('vite:preloadError', { cancelable: true });
 *   e.payload = err;
 *   window.dispatchEvent(e);
 *   if (!e.defaultPrevented) throw err;      // <-- preventDefault() => returns undefined
 * }
 * return promise.then((res) => {
 *   for (const item of res || []) {
 *     if (item.status !== 'rejected') continue;
 *     handlePreloadError(item.reason);       // arm 1: a CSS <link> preload failed
 *   }
 *   return baseModule().catch(handlePreloadError); // arm 2: the import itself failed
 * });
 * ```
 *
 * In **arm 1** suppressing the throw is harmless and useful: Vite carries on to
 * call `baseModule()`, so a stylesheet that merely failed to warm the cache
 * cannot fail the import on its own.
 *
 * In **arm 2** the handler's return value *is* the resolved module namespace.
 * Calling `preventDefault()` there makes a failed `import()` **resolve with
 * `undefined`** instead of rejecting - and because `window.location.reload()` is
 * asynchronous, every consumer awaiting that chunk keeps running for the
 * hundreds of milliseconds before the navigation commits, dereferencing
 * `undefined`:
 *
 *   - `React.lazy(() => import(...))` -> `_result.default` ->
 *     `TypeError: Cannot read properties of undefined (reading 'default')` - an
 *     UNCAUGHT render-phase throw that tears the tree down (issue #1941)
 *   - `const { fn } = await import(...)` ->
 *     `TypeError: Cannot destructure property 'fn' of '(intermediate value)' as
 *     it is undefined.` (issue #1938)
 *   - `import('maplibre-gl').then(ml => new ml.Map(...))` ->
 *     `TypeError: Cannot read properties of undefined (reading 'Map')`, which
 *     LocationMap's GPU `try/catch` then misread as a WebGL failure and latched
 *     for the session (issue #1926)
 *
 * None of those describe what went wrong, none are actionable, and each new
 * call site mints a fresh error-tracking issue. So: `preventDefault()` only on
 * arm 1. On arm 2 the import is left to reject, which is both the truth and the
 * shape every call site already handles - a React error boundary for `lazy`, a
 * `catch` at the await sites.
 *
 * The reload is still ours, and still bounded: debounced per tab, and refused
 * outright when the attempt cannot be recorded (a permanently-missing chunk
 * would otherwise reload forever). What the rejection costs us is telemetry
 * noise from an outcome the user never sees - handled by
 * {@link shouldSuppressChunkSkewNoise} below rather than by lying to the module
 * graph.
 */

/**
 * sessionStorage key holding the epoch-ms of the last chunk-skew reload.
 *
 * A TIMESTAMP, not a counter. The counter this replaces was reset on every mount
 * ("the entry executed, so the prior reload succeeded"), which is sound for the
 * ENTRY chunk that `index.html`'s boot watchdog guards, but not for a LAZY one:
 * the entry always executes, and the lazy chunk is not even requested until
 * after mount. The budget was therefore always fresh by the time the failure
 * happened, so a permanently-missing chunk (a genuinely broken deploy, a proxy
 * blocking the asset) reloaded in a tight loop on a blank page rather than
 * surfacing after one try. Reproduced in a browser against a 404ing lazy chunk.
 *
 * Debouncing on time fixes that and keeps the property the counter was there
 * for: a successful reload lands well inside the window, so it is never spent
 * twice on one skew, while a genuinely new deploy later in a long session still
 * gets to recover. Same policy, same reasoning as ./wasm-version-skew.ts.
 */
const RELOAD_TS_KEY = 'ifclite:chunk-skew-reload-ts';

/**
 * Minimum gap between chunk-skew reloads in one tab. Matches the wasm sibling:
 * long enough that one skew cannot spend two reloads, short enough that a second
 * deploy during a long session can still self-heal.
 */
const RELOAD_DEBOUNCE_MS = 60_000;

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

/** The `vite:preloadError` event, which carries the underlying error on `payload`. */
export interface VitePreloadErrorEvent extends Event {
  payload?: unknown;
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

export interface ChunkSkewDeps {
  now: () => number;
  reload: () => void;
  /** Has a chunk-skew reload already run inside the debounce window? */
  hasRecentReload: (now: number) => boolean;
  /** Persist the attempt. Returning false VETOES the reload (storage unavailable). */
  rememberReload: (now: number) => boolean;
  /** Record that a reload is in flight, so consequential exceptions can be dropped. */
  markReloadPending: (now: number) => void;
}

const defaultDeps: ChunkSkewDeps = {
  now: () => Date.now(),
  reload: () => window.location.reload(),
  hasRecentReload: (now) => {
    try {
      const raw = sessionStorage.getItem(RELOAD_TS_KEY);
      if (raw == null) return false;
      const ts = Number(raw);
      // `elapsed >= 0` is not pedantry: a stored timestamp in the FUTURE (an NTP
      // correction, a VM resume, a user changing the clock) makes `elapsed`
      // negative, which satisfies the `<` on its own and would pin this tab at
      // "recently reloaded" until wall time caught up - disabling skew recovery
      // for hours. Treat a future stamp as stale and allow the reload. Matches
      // the same guard in shouldSuppressChunkSkewNoise below.
      const elapsed = now - ts;
      return Number.isFinite(ts) && elapsed >= 0 && elapsed < RELOAD_DEBOUNCE_MS;
    } catch (err) {
      // Private mode / sandboxed frame / "block all cookies". Treated as
      // "recently reloaded" so the reload is refused: rememberReload would fail
      // too, and an unrecordable attempt must never be performed.
      console.warn('[chunk-reload] sessionStorage unreadable; letting preload error surface', err);
      return true;
    }
  },
  rememberReload: (now) => {
    try {
      sessionStorage.setItem(RELOAD_TS_KEY, String(now));
      // Confirm the write actually stuck: some embedders accept `setItem` and
      // silently discard it, which would leave the reload unbounded.
      return sessionStorage.getItem(RELOAD_TS_KEY) === String(now);
    } catch (err) {
      console.warn('[chunk-reload] sessionStorage unwritable; letting preload error surface', err);
      return false;
    }
  },
  markReloadPending: (now) => {
    reloadPendingSince = now;
  },
};

/** What the handler decided, exposed for tests and for the caller's own logging. */
export type ChunkSkewOutcome =
  /** Debounced or storage unusable - Vite re-throws, the error surfaces. */
  | 'surfaced'
  /** A reload was triggered. The import still rejects (arm 2) or continues (arm 1). */
  | 'reloaded';

/**
 * Decide what to do with one `vite:preloadError`. Exported with injectable deps
 * so the policy is unit-testable without a real `window`.
 */
export function handlePreloadError(
  event: VitePreloadErrorEvent,
  deps: ChunkSkewDeps = defaultDeps,
): ChunkSkewOutcome {
  // Arm 1 only (see the module doc): suppressing Vite's re-throw here keeps a
  // failed stylesheet preload from failing an import that would have succeeded.
  // Decided BEFORE the reload budget, because it is about what the import
  // resolves to, not about whether we reload.
  if (isCssPreloadFailure(event.payload)) event.preventDefault();

  const now = deps.now();
  if (deps.hasRecentReload(now)) return 'surfaced'; // already tried; do not loop
  if (!deps.rememberReload(now)) return 'surfaced'; // could not bound the retry

  deps.markReloadPending(now);
  deps.reload();
  return 'reloaded';
}

// ── Telemetry noise suppression ─────────────────────────────────────────────
// Between `reload()` and the navigation actually committing, the document keeps
// running: pending microtasks resolve, React commits a frame, timers fire. Every
// consumer still waiting on the chunk that just 404'd fails in that window. Those
// failures are consequences of a condition we have ALREADY fixed - the tab is
// about to come back on fresh assets - so they are pure noise, and each distinct
// call site mints its own error-tracking issue (and its own auto-filed GitHub
// issue) for the same one bug. That is how #1926, #1938 and #1941 arrived as
// three unrelated-looking TypeErrors.
//
// The gate is TIME, not message matching, and deliberately so: the consequences
// carry arbitrary messages ("Cannot read properties of undefined (reading
// 'Map')") that share no vocabulary with the cause, so any matcher would have to
// enumerate call sites and would silently rot as new ones are added.
//
// Two properties keep this from hiding real breakage:
//   - The flag lives in MODULE MEMORY, never in storage, so it cannot outlive
//     the document. A reload always lands with a clean slate.
//   - It is only ever set on the path that actually reloads. When the budget is
//     spent (`surfaced`) - i.e. a reload already failed to fix this, the
//     genuinely-broken-deploy case - nothing is suppressed and every exception
//     reaches error tracking, which is exactly when we need to hear about it.
let reloadPendingSince: number | null = null;

/**
 * Upper bound on the suppression window. `reload()` normally commits in tens of
 * milliseconds, but a `beforeunload` prompt or a slow server can stretch it  -
 * and if the navigation is cancelled outright it would never end at all. After
 * this long, errors surface again even though the flag was set.
 */
const RELOAD_SUPPRESSION_WINDOW_MS = 10_000;

export interface ChunkSkewNoiseDeps {
  now: () => number;
  reloadPendingSince: () => number | null;
}

const defaultNoiseDeps: ChunkSkewNoiseDeps = {
  now: () => Date.now(),
  reloadPendingSince: () => reloadPendingSince,
};

/**
 * Decide whether a captured PostHog event is collateral from an in-flight
 * chunk-skew reload and should be dropped. Returns `true` to DROP.
 *
 * Only `$exception` events are eligible: a `$pageleave` or a product event fired
 * in the same window is still true and still worth having.
 */
export function shouldSuppressChunkSkewNoise(
  event: { event?: string; properties?: Record<string, unknown> } | null,
  deps: ChunkSkewNoiseDeps = defaultNoiseDeps,
): boolean {
  if (!event || event.event !== '$exception') return false;
  const since = deps.reloadPendingSince();
  if (since === null) return false;
  const elapsed = deps.now() - since;
  // A clock that jumped backwards would make `elapsed` negative and suppress
  // indefinitely; treat anything outside the forward window as "not pending".
  return elapsed >= 0 && elapsed < RELOAD_SUPPRESSION_WINDOW_MS;
}

let installed = false;

/**
 * Wire the `vite:preloadError` recovery. Idempotent; call once at app boot. No-op
 * outside a browser window (SSR / tests without a DOM).
 *
 * Complements the inline boot self-heal in `index.html`, which handles the ENTRY
 * chunk failing to load; this handles a LAZY chunk (exporters / ids / bcf /
 * sandbox ...) 404ing after a newer deploy ships fresh hashes mid-session.
 */
export function installChunkVersionSkewRecovery(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('vite:preloadError', (event) => {
    handlePreloadError(event as VitePreloadErrorEvent);
  });
}

/** Test-only: reset the install guard and the in-flight reload flag. */
export function __resetChunkVersionSkewForTests(): void {
  installed = false;
  reloadPendingSince = null;
}

/**
 * Test-only: drive the module-private in-flight flag directly.
 *
 * The flag is normally set by {@link handlePreloadError} through its default
 * deps, which need a real `window` and `sessionStorage`. This lets the
 * `before_send` wiring in ./analytics.ts be tested for what it actually has to
 * guarantee - that the gate is CONNECTED - without a DOM.
 */
export function __setChunkReloadPendingForTests(now: number | null): void {
  reloadPendingSince = now;
}
