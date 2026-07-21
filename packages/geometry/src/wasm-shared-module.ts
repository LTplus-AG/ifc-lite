/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ONE compiled `WebAssembly.Module` per binary per session, shared by every
 * consumer of the geometry engine in this realm.
 *
 * Two independent code paths need the ~3.9 MB engine binary and used to fetch
 * and compile it separately:
 *   - the N-worker pool (`geometry-parallel.ts`), which structured-clones a
 *     compiled module to each worker (#1818 — before that, N parallel compiles
 *     of a multi-MB module contended on the CPU and produced a multi-second
 *     "WASM ready" stagger before any geometry was meshed);
 *   - the main-thread `IfcLiteBridge.init()` path, used by the adaptive sync
 *     route for small files and by the export/bridge APIs, which calls
 *     wasm-bindgen `init()` and lets IT fetch + compile.
 *
 * Keeping the memo here — rather than private to the worker pool — means the
 * second path can reuse whatever the first already compiled, so the binary is
 * fetched at most once per URL per realm no matter which path runs first. That
 * matters most when the two overlap: a prewarm started at page load and a small
 * file opened seconds later would otherwise be two concurrent downloads of the
 * same 1.3 MB (browsers are not required to coalesce in-flight requests for the
 * same URL), on exactly the slow connections the prewarm exists to help.
 */

// Keyed by the RESOLVED wasm URL, not a single global slot: federation / version
// skew can load a DIFFERENT binary in the same session, and returning the first
// compiled module for a later, incompatible URL would initialize the consumer's
// wasm-bindgen glue against the wrong module. One promise per distinct binary.
const sharedWasmModulePromises = new Map<string, Promise<WebAssembly.Module | null>>();

function resolveWasmUrl(explicitUrl?: string): string | URL | null {
  if (explicitUrl) return explicitUrl;
  try {
    // Source-aliased (Vite) build: the sibling `@ifc-lite/wasm` package's
    // binary, resolved relative to THIS module. Vite statically rewrites this
    // `new URL(..., import.meta.url)` to the emitted, content-hashed asset URL
    // — the same asset the worker's wasm-bindgen glue resolves. In a plain
    // tsc/npm build it resolves against dist/ and may 404, which the caller
    // treats as "no shared module" and falls back to per-consumer init.
    //
    // NOTE: this specifier is relative to THIS FILE. It must stay in
    // packages/geometry/src/ alongside its original home in
    // geometry-parallel.ts, or Vite rewrites it to a different (404) asset.
    return new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  } catch {
    return null;
  }
}

/**
 * Compile (or join the in-flight compile of) the engine binary for `explicitUrl`
 * — or the default resolution when omitted.
 *
 * Resolves to `null` — the caller then leaves the consumer on its own `init()` —
 * when the URL can't be resolved or compilation fails, so non-Vite consumers and
 * offline/edge failures degrade to the previous behaviour rather than breaking.
 */
export async function compileSharedWasmModule(
  explicitUrl?: string,
): Promise<WebAssembly.Module | null> {
  if (typeof WebAssembly === 'undefined') return null;
  const url = resolveWasmUrl(explicitUrl);
  if (!url) return null;
  const cacheKey = url instanceof URL ? url.href : url;
  const cached = sharedWasmModulePromises.get(cacheKey);
  if (cached) return cached;
  const p = (async (): Promise<WebAssembly.Module | null> => {
    try {
      if (typeof WebAssembly.compileStreaming === 'function') {
        try {
          // Compile WHILE the binary downloads (one streaming fetch + compile
          // for every consumer).
          return await WebAssembly.compileStreaming(fetch(url));
        } catch {
          // Some static hosts serve `.wasm` with the wrong MIME type, which
          // rejects compileStreaming — fall through to the buffer path.
        }
      }
      const resp = await fetch(url);
      if (!resp.ok) return null;
      return await WebAssembly.compile(await resp.arrayBuffer());
    } catch (err) {
      console.warn('[stream] shared wasm compile failed; consumers will self-init:', err);
      return null;
    }
  })();
  sharedWasmModulePromises.set(cacheKey, p);
  const result = await p;
  // Don't cache a failure — evict ONLY this URL's entry so the next load retries
  // (a transient fetch error shouldn't permanently disable the shared-module fast
  // path for the session), while other URLs' successful modules stay cached.
  if (result === null) sharedWasmModulePromises.delete(cacheKey);
  return result;
}

/**
 * The compiled module for `explicitUrl` **only if a compile was already started**
 * for it — otherwise `null`, without starting one.
 *
 * This is the "join, don't initiate" accessor for consumers that have their own
 * working init path (`IfcLiteBridge.init()`): when a prewarm or a parallel load
 * has already fetched the binary, reuse it; when nothing has, do exactly what
 * this consumer did before rather than speculatively pulling 1.3 MB on a path
 * that may not need it.
 *
 * Awaits an in-flight compile rather than racing it with a second fetch — the
 * bytes are the same and already on the wire.
 */
export function getStartedSharedWasmModule(
  explicitUrl?: string,
): Promise<WebAssembly.Module | null> | null {
  const url = resolveWasmUrl(explicitUrl);
  if (!url) return null;
  const cacheKey = url instanceof URL ? url.href : url;
  return sharedWasmModulePromises.get(cacheKey) ?? null;
}

/**
 * Start the shared fetch+compile BEFORE a file is opened, so the binary is
 * already downloaded and compiled by the time a load wants it.
 *
 * Without this the binary (~1.3 MB over the wire) is fetched lazily, on the
 * click that opens a model: nothing overlaps the user's think time, and on a
 * slow link the whole download sits in front of first geometry (measured 2.5 s
 * on a ~4 Mbit connection, for a 225 KB model).
 *
 * Fire-and-forget by design: a prewarm failure must never surface to the user or
 * poison the load path. `compileSharedWasmModule` already evicts a failed URL so
 * the real load retries, and every consumer falls back to its own `init()` when
 * no shared module is available. Callers decide *when* to call this (idle,
 * intent) and whether the connection can afford it.
 *
 * `wasmUrl` MUST match the URL the subsequent load resolves — the memo is keyed
 * on it, so prewarming one binary and loading another downloads both.
 * Vite/webpack consumers (the viewer included) pass none and share the default
 * resolution, which is the intended usage.
 */
export function prewarmSharedWasmModule(wasmUrl?: string): void {
  void compileSharedWasmModule(wasmUrl).catch((err) => {
    // Unreachable in practice — compileSharedWasmModule swallows its own
    // failures and resolves null — but never let a prewarm reject unhandled.
    console.warn('[stream] wasm prewarm failed; load path will retry:', err);
  });
}
