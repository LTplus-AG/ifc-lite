/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cold-start prewarm for the geometry engine binary.
 *
 * The ~3.9 MB wasm (~1.3 MB brotli) is fetched lazily by `processParallel`, so
 * on a cold cache the whole download sits between "user picks a file" and
 * "first geometry" — nothing overlaps the seconds the user spends in the file
 * picker. Measured on a ~4 Mbit link: 2535 ms of wasm download for a 225 KB
 * model, started 72 ms AFTER the file was handed to the loader.
 *
 * Starting the same fetch when the app goes idle moves that cost off the
 * critical path entirely. `prewarmSharedWasmModule` memoises per resolved URL,
 * so the real load then awaits the in-flight promise rather than re-fetching,
 * and a prewarm that fails degrades to exactly today's behaviour.
 *
 * Deliberately NOT prewarmed on a metered or very slow connection: a visitor
 * who never opens a model shouldn't spend 1.3 MB of their data plan on an
 * engine they didn't ask for. They pay it on first load instead, as today.
 */

/** Subset of the (non-standard, Chromium-only) NetworkInformation we consult. */
interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

function connection(): NetworkInformationLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
}

/**
 * True when the engine binary should NOT be speculatively downloaded: the user
 * asked for reduced data use, or the link is slow enough that a 1.3 MB
 * speculative fetch would compete with whatever they're actually doing.
 * Unknown / unsupported (`navigator.connection` absent, e.g. Safari & Firefox)
 * counts as affordable — the common case is a normal broadband connection.
 */
export function shouldSkipPrewarm(conn: NetworkInformationLike | undefined): boolean {
  if (!conn) return false;
  if (conn.saveData === true) return true;
  return conn.effectiveType === '2g' || conn.effectiveType === 'slow-2g';
}

let scheduled = false;

/**
 * Schedule the engine prewarm for the next idle period. Safe to call more than
 * once — only the first call schedules, and the underlying compile is memoised
 * per binary URL regardless.
 */
export function scheduleWasmPrewarm(): void {
  if (scheduled || typeof window === 'undefined') return;
  // Gate BEFORE latching: a session that was on a metered/2g link at mount can
  // become eligible later, and latching first would lock it out for good.
  if (shouldSkipPrewarm(connection())) return;
  scheduled = true;

  const run = () => {
    // Imported dynamically so this module has no load-order dependency on the
    // geometry package. (It does NOT keep it out of the entry chunk —
    // useIfcLoader value-imports GeometryProcessor, so @ifc-lite/geometry is
    // already in the entry graph and this resolves from memory.)
    void import('@ifc-lite/geometry')
      .then(({ prewarmSharedWasmModule }) => prewarmSharedWasmModule())
      .catch((err) => {
        console.warn('[wasm-prewarm] engine prewarm skipped:', err);
      });
  };

  // `timeout` bounds the wait on a busy main thread; the fallback covers
  // browsers without requestIdleCallback (Safari < 17).
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 3000 });
  } else {
    window.setTimeout(run, 1500);
  }
}
