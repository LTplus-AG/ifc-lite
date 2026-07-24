/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opt-in loader for the THREADED wasm bundle (in-instance rayon pool via
 * `wasm-bindgen-rayon`, shared memory + atomics). See
 * `docs/architecture/csg-threading-design.md` for the measured evidence
 * (2.9-4.2x on the CSG step, ~1.6-1.9x naive whole-pipeline) and
 * `scripts/build-wasm.sh BUILD_THREADED=1`, which already produces this
 * bundle at `packages/wasm/pkg-threaded/` (gitignored build artifact,
 * NOT shipped by default — this module is the only thing that ever loads it).
 *
 * This is a SPIKE-grade opt-in, not a production default:
 *   - Enabled only via `?csgThreads=N` in the page URL (mirrors the existing
 *     `?geomWorkers=N` A/B knob — see `worker-count.ts`).
 *   - Requires `SharedArrayBuffer` + `crossOriginIsolated` (both already true
 *     in production per `vercel.json`'s COOP/COEP headers, but Safari does not
 *     support `credentialless` COEP and is therefore never cross-origin
 *     isolated — it silently stays on the plain single-thread bundle).
 *   - ANY failure (bundle not built for this deployment, `initThreadPool`
 *     rejecting, worker bootstrap failing) falls back to the plain bundle
 *     silently — this must never be the reason a model fails to load.
 */

/** Sanity bounds mirroring `getGeomWorkerOverride`'s `[1, 16]` clamp. */
const MIN_CSG_THREADS = 1;
const MAX_CSG_THREADS = 16;

/**
 * Parse an explicit CSG-thread-pool size from a query string (or
 * `window.location.search` when omitted / not in a browser-like scope).
 *
 * `?csgThreads=0` and `?csgThreads=off` both mean "disabled" (parity with
 * `?geomWorkers=0`/`auto`). Out-of-range or non-numeric values are ignored
 * rather than throwing — a malformed URL param degrades to the default
 * (serial) path, not a load failure.
 */
export function parseCsgThreadsOverride(search?: string): number | undefined {
  let src = search;
  if (src == null) {
    if (typeof window === 'undefined' || !window.location) return undefined;
    src = window.location.search;
  }
  if (!src) return undefined;
  try {
    const param = new URLSearchParams(src).get('csgThreads');
    if (param == null) return undefined;
    if (param === '0' || param === 'off') return undefined;
    const n = Number.parseInt(param, 10);
    if (Number.isFinite(n) && n >= MIN_CSG_THREADS && n <= MAX_CSG_THREADS) return n;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when this realm (window OR worker) can actually run a shared-memory
 * threaded wasm instance: `SharedArrayBuffer` must exist AND the realm must be
 * cross-origin isolated. Safari never satisfies this (no `credentialless`
 * COEP support), by design — see the design doc's "two bundles" rationale.
 */
export function isCsgThreadsEnvSupported(): boolean {
  try {
    if (typeof SharedArrayBuffer === 'undefined') return false;
    // `crossOriginIsolated` is a global in both window and worker scopes.
    // Guard with `typeof` since some embedders (older browsers, some
    // sandboxed test runners) don't define it at all.
    return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;
  } catch {
    return false;
  }
}

/** Structural shape of the threaded bundle's wasm-bindgen glue module. Kept
 *  minimal (only what this loader needs) rather than importing `@ifc-lite/wasm`'s
 *  full type surface, since the threaded bundle is a SEPARATE build (built from
 *  the identical Rust source via `--features threads`, so the generated shape
 *  matches, but it is not the nominal same TS type). */
export interface ThreadedWasmModule {
  /** wasm-bindgen's default init export. */
  default: (urlOrModule?: unknown) => Promise<unknown>;
  /** The engine's `IfcAPI` class, same public shape as `@ifc-lite/wasm`'s. */
  IfcAPI: new () => object;
  /** wasm-bindgen-rayon's exported pool bootstrap (re-exported from
   *  `rust/wasm-bindings/src/lib.rs` under the `threads` feature). */
  initThreadPool: (numThreads: number) => Promise<unknown>;
}

// One load attempt per realm (module-level — each Worker has its own JS
// realm and therefore its own copy of this module, so this memo is
// per-worker, not global across the whole worker pool).
let threadedModulePromise: Promise<ThreadedWasmModule | null> | null = null;

/**
 * Dynamically import the threaded bundle, initialize it, and spin up its
 * internal rayon pool at `threadCount` threads. Resolves to `null` — never
 * throws — on ANY failure, so callers can unconditionally fall back to the
 * plain single-thread bundle:
 *   - the bundle wasn't built for this deployment (`BUILD_THREADED=1` is
 *     off by default, so `packages/wasm/pkg-threaded/` commonly 404s);
 *   - the environment isn't cross-origin isolated (checked up front, but
 *     re-verified here defensively);
 *   - `initThreadPool` rejects (e.g. the wasm-bindgen-rayon worker-helper
 *     directory-import issue on an unbundled host — see the design doc's
 *     "Required patch" section; `scripts/build-wasm.sh` already applies it,
 *     but a host serving a THIRD-PARTY-built threaded bundle might not have).
 *
 * Idempotent per realm: a second call with a different `threadCount` returns
 * the ALREADY-initialized pool (its size is fixed at first successful init),
 * matching wasm-bindgen-rayon's own one-pool-per-instance contract.
 */
export function loadThreadedWasmModule(threadCount: number): Promise<ThreadedWasmModule | null> {
  if (threadedModulePromise) return threadedModulePromise;
  threadedModulePromise = (async (): Promise<ThreadedWasmModule | null> => {
    if (!isCsgThreadsEnvSupported()) return null;
    try {
      // Relative to THIS file, mirroring `wasm-shared-module.ts`'s resolution
      // of the plain bundle's binary. Must stay in packages/geometry/src/ (not
      // moved into a deeper subdirectory) or the relative path below drifts.
      // `pkg-threaded/` is a gitignored build artifact (scripts/build-wasm.sh
      // BUILD_THREADED=1) — it will not exist in most deployments, which is
      // exactly the common case this function must degrade gracefully from.
      const url = new URL('../../wasm/pkg-threaded/ifc-lite.js', import.meta.url);
      // `@vite-ignore`: this import target does not exist at build time in the
      // default (non-BUILD_THREADED) tree, so it must not be statically
      // analyzed/bundled — only ever resolved at runtime, and only when the
      // opt-in query param + cross-origin isolation gate above already passed.
      const mod = (await import(/* @vite-ignore */ url.href)) as unknown as ThreadedWasmModule;
      if (typeof mod?.default !== 'function' || typeof mod?.initThreadPool !== 'function') {
        console.warn('[csg-threads] threaded bundle missing expected exports; falling back to serial CSG');
        return null;
      }
      await mod.default();
      await mod.initThreadPool(Math.max(1, Math.floor(threadCount)));
      return mod;
    } catch (err) {
      console.warn('[csg-threads] threaded wasm bundle unavailable; falling back to serial CSG:', err);
      return null;
    }
  })();
  return threadedModulePromise;
}
