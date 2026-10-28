/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turn the bare wasm trap a huge model triggers in the streaming prepass into an
 * actionable, human-readable error.
 *
 * wasm-bindgen copies even a SAB-backed byte slice into linear memory. Index
 * tables, metadata fallback indexes and discovery lists share its 4 GiB limit.
 * See docs/architecture/prepass-memory.md for the allocation accounting.
 */

/** Map failed attempts from 1 GB, including observed 1.6–1.8 GB pre-pass traps. */
const HUGE_FILE_GB_THRESHOLD = 1.0;

/** wasm OOM / abort signatures across engines (V8, SpiderMonkey, JSC). */
const OOM_SIGNATURE =
  /unreachable|out of memory|memory access|RuntimeError|allocat|enlarge memory|grow memory|could not allocate/i;

/**
 * Returns a clear error when `err` looks like a wasm OOM trap on a large file,
 * else `null` (the caller then rethrows the original error unchanged).
 *
 * IMPORTANT: a Rust panic and a wasm OOM abort BOTH surface to JS as the SAME
 * `RuntimeError: unreachable executed` — `console_error_panic_hook` prints to
 * the console but does not re-type the exception, so the message alone can't
 * prove OOM. This is intentionally a heuristic (large file + an OOM-shaped
 * trap — the failure can be memory pressure or the 4GB ceiling). To make
 * sure it never SILENTLY masks a genuine panic/assert on a large model, the
 * mapped error preserves the original trap: verbatim in the message tail and as
 * `.cause` for programmatic inspection.
 */
export function largeFilePrepassError(err: unknown, byteLength: number): Error | null {
  const sizeGB = byteLength / 1e9;
  const raw = err instanceof Error ? err.message : String(err);
  if (sizeGB >= HUGE_FILE_GB_THRESHOLD && OOM_SIGNATURE.test(raw)) {
    return new Error(
      `Out of memory: this model is ${sizeGB.toFixed(1)} GB and may exceed available WebAssembly memory ` +
        `(32-bit address space). Try a smaller model or use the native ifc-lite CLI/server. ` +
        `(underlying wasm trap: ${raw})`,
      { cause: err },
    );
  }
  return null;
}
