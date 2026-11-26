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

import { useViewerStore } from '@/store';
import { onPendingProcessedModelChange, processedModelRequested } from './processed-model.js';
import { onFieldTelemetry } from './perf/fieldTelemetryLoader.js';
import { supportsWasmSimd } from './wasm-simd-support.js';

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
 * once. If a model is queued or loading, wait for it to settle before
 * trying again. The underlying compile is memoised per binary URL.
 */
export function scheduleWasmPrewarm(): void {
  if (scheduled || typeof window === 'undefined') return;
  // Gate BEFORE latching: a session that was on a metered/2g link at mount can
  // become eligible later, and latching first would lock it out for good.
  // Without SIMD the binary cannot compile, so downloading it is waste (#10784).
  if (!supportsWasmSimd() || shouldSkipPrewarm(connection())) return;
  scheduled = true;

  const isLoading = () => processedModelRequested() || useViewerStore.getState().loading;
  // A prewarm that waited for a load is not a boot-time compile; keep it out of viewer_boot.
  let waitedForLoad = false;
  const arm = () => {
    if (isLoading()) {
      waitedForLoad = true;
      let waiting = true;
      const resume = () => {
        if (!waiting || isLoading()) return;
        waiting = false;
        offStore();
        offPending();
        arm();
      };
      const offStore = useViewerStore.subscribe((state, previous) => {
        if (state.loading !== previous.loading) resume();
      });
      // The autoload takes the request before setting loading in the same turn.
      const offPending = onPendingProcessedModelChange(() => queueMicrotask(resume));
      return;
    }
    // The fallback covers browsers without requestIdleCallback (Safari < 17).
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 3000 });
    else window.setTimeout(run, 1500);
  };

  const run = () => {
    if (isLoading()) {
      arm();
      return;
    }
    // Geometry already ships with the loader. Import it here to keep prewarm
    // independent of the order in which the viewer modules are initialized.
    const startedAt = performance.now();
    void import('@ifc-lite/geometry')
      .then(async ({ prewarmSharedWasmModule }) => {
        if (isLoading()) {
          arm();
          return;
        }
        if (shouldSkipPrewarm(connection())) {
          scheduled = false;
          return;
        }
        const compiled = await prewarmSharedWasmModule();
        const endedAt = performance.now();
        // `viewer_boot` (#6961): when the engine binary finished compiling at boot.
        if (!waitedForLoad) onFieldTelemetry((field) => field.noteEngineCompiled(startedAt, endedAt, compiled));
      })
      .catch((err) => {
        console.warn('[wasm-prewarm] engine prewarm skipped:', err);
      });
  };

  arm();
}

let fastPathScheduled = false;

/**
 * Load the small-file fast-path runtime (lib/fast-path/startFastPath.ts) at
 * the next idle period. Only the dynamic import lives here; the runtime
 * decides for itself whether this browser may prepare anything.
 */
export function scheduleFastPath(): void {
  // The spare workers compile the same engine binary (#10784).
  if (fastPathScheduled || typeof window === 'undefined' || !supportsWasmSimd()) return;
  fastPathScheduled = true;
  const run = () => {
    void import('./fast-path/startFastPath')
      .then(({ startFastPath }) => { startFastPath(); })
      .catch((err) => console.warn('[fast-path] runtime not loaded:', err));
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4000 });
  else window.setTimeout(run, 2000);
}
