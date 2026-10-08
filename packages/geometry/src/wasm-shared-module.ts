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
 * shared on pool-first and bundled main-init-first loads. Unbundled main init
 * keeps wasm-bindgen's own asset resolution. Sharing matters most when
 * the two overlap: a prewarm started at page load and a small
 * file opened seconds later would otherwise be two concurrent downloads of the
 * same 1.3 MB (browsers are not required to coalesce in-flight requests for the
 * same URL), on exactly the slow connections the prewarm exists to help.
 */

// Keyed by the RESOLVED wasm URL, not a single global slot: federation / version
// skew can load a DIFFERENT binary in the same session, and returning the first
// compiled module for a later, incompatible URL would initialize the consumer's
// wasm-bindgen glue against the wrong module. One promise per distinct binary.
const sharedWasmModulePromises = new Map<string, Promise<WebAssembly.Module>>();

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

// Match wasm-bindgen's public loader: a successful ordinary response with the
// wrong MIME type may use its bytes; transport/validation failures retain their
// original rejection. In particular, invalid application/wasm is not retried.
function permitsMimeFallback(response: Response): boolean {
  return response.ok
    && ['basic', 'cors', 'default'].includes(response.type)
    && response.headers.get('Content-Type') !== 'application/wasm';
}

function acquireModule(url: string | URL): Promise<WebAssembly.Module> {
  const key = url instanceof URL ? url.href : url;
  const cached = sharedWasmModulePromises.get(key);
  if (cached) return cached;
  const promise: Promise<WebAssembly.Module> = (async () => {
    const response = await fetch(url);
    if (typeof WebAssembly.compileStreaming !== 'function') {
      // Preserve the optional helper's HTTP refusal even when its streaming API
      // is absent. Main init must not accept bytes a present public streaming
      // loader would reject. This is stricter than glue with both APIs absent.
      if (!response.ok) throw new TypeError('WebAssembly HTTP status code is not ok');
      if (!['basic', 'cors', 'default'].includes(response.type)) {
        throw new TypeError('WebAssembly response type is not supported');
      }
      return WebAssembly.compile(await response.arrayBuffer());
    }
    // Like generated init, permitted MIME rejection leaves the original body
    // available for arrayBuffer. Do not tee/clone or fetch the binary again.
    try {
      return await WebAssembly.compileStreaming(response);
    } catch (error) {
      if (!permitsMimeFallback(response)) throw error;
      console.warn('[stream] wasm compileStreaming rejected MIME; using the same response bytes:', error);
      return WebAssembly.compile(await response.arrayBuffer());
    }
  })().catch((error: unknown) => {
    // Evict the owner, not a replacement installed by a later load. All joining
    // callers see the original rejection; the bridge's retry can start anew.
    if (sharedWasmModulePromises.get(key) === promise) sharedWasmModulePromises.delete(key);
    throw error;
  });
  sharedWasmModulePromises.set(key, promise);
  return promise;
}

const warnedFailures = new WeakSet<Promise<WebAssembly.Module>>();

function optionalModule(promise: Promise<WebAssembly.Module>): Promise<WebAssembly.Module | null> {
  return promise.catch((error: unknown) => {
    if (!warnedFailures.has(promise)) {
      warnedFailures.add(promise);
      console.warn('[stream] shared wasm compile failed; consumers will self-init:', error);
    }
    return null;
  });
}

/**
 * Compile or join the engine binary. The pool's optional contract stays null on
 * failure; the memo itself preserves rejection for the main loader's retry.
 */
export function compileSharedWasmModule(explicitUrl?: string): Promise<WebAssembly.Module | null> {
  if (typeof WebAssembly === 'undefined') return Promise.resolve(null);
  const url = resolveWasmUrl(explicitUrl);
  return url ? optionalModule(acquireModule(url)) : Promise.resolve(null);
}

/** Modern public init options; deliberately not a package-root export. */
type SharedWasmInitOptions = {
  module_or_path: WebAssembly.Module | Promise<WebAssembly.Module>;
};

/**
 * Prepare main init without starting a bundled fetch. Generated public init
 * returns an already initialized engine BEFORE reading module_or_path. A cold
 * loader reads this getter and starts/joins the strict memo inside its retry.
 *
 * Raw sibling URLs do not prove the installed npm asset location. Only join an
 * existing optional memo there, then give the loader concrete options or no
 * options. Promise<undefined> would bypass the loader's default URL selection.
 * The second URL constructor uses a parameter so bundlers leave it untouched.
 */
export async function prepareSharedWasmInit(
  resolvedUrl: string | URL | null = resolveWasmUrl(),
  moduleUrl: string = import.meta.url,
): Promise<SharedWasmInitOptions | undefined> {
  if (!resolvedUrl || typeof WebAssembly === 'undefined') return undefined;
  const cacheKey = resolvedUrl instanceof URL ? resolvedUrl.href : resolvedUrl;
  const resolved = new URL(cacheKey, moduleUrl);
  const unbundled = new URL('../../wasm/pkg/ifc-lite_bg.wasm', moduleUrl);
  if (resolved.href === unbundled.href || !['http:', 'https:'].includes(resolved.protocol)) {
    const cached = sharedWasmModulePromises.get(cacheKey);
    const module = cached ? await optionalModule(cached) : null;
    return module ? { module_or_path: module } : undefined;
  }
  return {
    get module_or_path(): Promise<WebAssembly.Module> { return acquireModule(cacheKey); },
  };
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
 * Fire-and-forget by design (the returned promise never rejects): a prewarm failure must never surface to the user or
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
export function prewarmSharedWasmModule(wasmUrl?: string): Promise<boolean> {
  // Resolves whether a module compiled (the viewer's `viewer_boot` field
  // event times it, #6961); callers that only prewarm can ignore it.
  return compileSharedWasmModule(wasmUrl).then((module) => module !== null, (err) => {
    // Unreachable in practice — compileSharedWasmModule swallows its own
    // failures and resolves null — but never let a prewarm reject unhandled.
    console.warn('[stream] wasm prewarm failed; load path will retry:', err);
    return false;
  });
}
