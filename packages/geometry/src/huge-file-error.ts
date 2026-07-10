/**
 * Turn the bare wasm trap a huge model triggers in the streaming prepass into an
 * actionable, human-readable error.
 *
 * The streaming prepass (`buildPrePassStreaming`) copies the whole file into
 * wasm linear memory AND builds the entity index alongside it. On wasm32 the
 * address space is capped at 4GB, so a ~3GB+ file cannot fit — the allocator
 * aborts with a bare `unreachable executed` / `RuntimeError`. This maps that to
 * a clear message pointing at the desktop app (which is 64-bit, no such limit).
 */

/** Below this the failure is treated as unrelated to size (caller rethrows). */
const HUGE_FILE_GB_THRESHOLD = 2.5;

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
 * trap, and the caller only invokes it AFTER both the SAB-view and the full
 * in-memory copy attempts trapped — overwhelmingly the 4GB ceiling). To make
 * sure it never SILENTLY masks a genuine panic/assert on a large model, the
 * mapped error preserves the original trap: verbatim in the message tail and as
 * `.cause` for programmatic inspection.
 */
export function largeFilePrepassError(err: unknown, byteLength: number): Error | null {
  const sizeGB = byteLength / 1e9;
  const raw = err instanceof Error ? err.message : String(err);
  if (sizeGB >= HUGE_FILE_GB_THRESHOLD && OOM_SIGNATURE.test(raw)) {
    return new Error(
      `This model is ${sizeGB.toFixed(1)} GB, which exceeds the browser's ~3 GB WebAssembly memory ` +
        `ceiling (32-bit address space). Open it in the ifc-lite desktop app, which has no such limit. ` +
        `(underlying wasm trap: ${raw})`,
      { cause: err },
    );
  }
  return null;
}
