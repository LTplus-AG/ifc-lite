/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification + humanisation of model-load failures.
 *
 * The geometry/parser workers both initialise the same `@ifc-lite/wasm`
 * binary. wasm-bindgen's streaming loader rethrows on a non-OK HTTP status
 * (it only falls back for the wrong-MIME case), surfacing as a cryptic
 * `TypeError: Failed to execute 'compile' on 'WebAssembly': HTTP status code
 * is not ok`. That message is meaningless to a user and, captured raw, is
 * hard to triage in error tracking.
 *
 * This module maps such failures to a stable `kind` (for analytics
 * grouping) and a human-readable message (for the toast / model loadError).
 */

/** Stable, analytics-friendly classification of a load failure. */
export type LoadErrorKind =
  /** The WebAssembly geometry engine binary failed to download/compile. */
  | 'wasm_engine_load'
  /** Out-of-memory / WASM heap exhaustion during processing. */
  | 'out_of_memory'
  /**
   * A geometry worker (or the wasm mesher running in it) stopped unexpectedly
   * — a hard worker crash (`worker.onerror`, no message) or a wasm runtime
   * trap (`unreachable`, `RuntimeError`) surfaced during processing. On heavy
   * models this is almost always memory pressure that didn't reach the JS heap
   * as a clean OOM, so it is grouped separately from `out_of_memory` only for
   * triage — the user guidance is the same.
   */
  | 'geometry_worker_crash'
  /**
   * The geometry stream watchdog fired: no batch arrived within the grace
   * window. A derived symptom — usually downstream of a worker crash/OOM, or a
   * genuinely too-large/complex model that never streams on this device.
   */
  | 'geometry_stream_stalled'
  /** The user (or a superseding load) cancelled the operation. */
  | 'cancelled'
  /** Anything else. */
  | 'unknown';

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * The geometry engine binary (`ifc-lite_bg.wasm`) failed to load. This is a
 * download/compile failure of the WASM module itself, not a problem with the
 * IFC file — the binary 404'd, was served with a non-OK status, or the fetch
 * was blocked (corporate proxy / antivirus / offline). wasm-bindgen's loader
 * cannot recover from a non-OK HTTP status, so it rethrows.
 */
function isWasmEngineLoadError(message: string): boolean {
  return (
    /HTTP status code is not ok/i.test(message) ||
    // `compile`/`compileStreaming`/`instantiate`/`instantiateStreaming` on `WebAssembly`.
    /'(compile|compileStreaming|instantiate|instantiateStreaming)' on 'WebAssembly'/i.test(message) ||
    // Streaming-fetch failure for the engine binary specifically.
    (/wasm/i.test(message) && /failed to fetch|networkerror|load failed/i.test(message)) ||
    /ifc-lite_bg\.wasm/i.test(message)
  );
}

function isOutOfMemoryError(message: string): boolean {
  return (
    /out of memory|oom|memory access out of bounds|cannot enlarge memory|allocation failed|maximum call stack|array buffer allocation failed|rangeerror: (?:invalid array|array buffer)/i.test(
      message,
    )
  );
}

/**
 * The geometry stream watchdog timed out (see `useIfcLoader`'s `Promise.race`).
 * Matched on the stable prefix only — the message must NOT carry the file name
 * (it would leak a confidential model name into error tracking), so we never
 * rely on anything past "stalled".
 */
function isStreamStalledError(message: string): boolean {
  return /geometry stream stalled/i.test(message);
}

/**
 * A geometry worker explicitly reported a failure. Covers the messages the
 * worker pool produces:
 *  - `worker.onerror` wrapped as "Geometry worker failed: …" (an empty
 *    `ErrorEvent` from a hard crash — classic OOM kill of the worker thread),
 *  - "Geometry worker error: …" (the worker posted a `{type:'error'}` message,
 *    e.g. "Geometry worker error: unreachable").
 *
 * Deliberately keyed on the "geometry worker" marker only. A *bare* wasm trap
 * (`unreachable`, `RuntimeError`) is NOT attributed here: the viewer runs other
 * wasm (space-plate, parquet) whose traps would otherwise be mis-bucketed as the
 * geometry family and wrongly suppressed. Those stay `unknown` and surface on
 * their own. (The worker pool always wraps its failures with the marker, so a
 * genuine geometry-worker trap still lands here via the "Geometry worker …"
 * prefix.)
 */
function isGeometryWorkerCrashError(message: string): boolean {
  return /geometry worker (?:failed|error|crashed|terminated)/i.test(message);
}

function isCancelledError(message: string): boolean {
  return /\bcancel(?:led|ed)?\b|aborterror|the operation was aborted/i.test(message);
}

/** Classify a load failure into a stable analytics bucket. */
export function classifyLoadError(err: unknown): LoadErrorKind {
  const message = messageOf(err);
  if (isWasmEngineLoadError(message)) return 'wasm_engine_load';
  // Explicit memory-exhaustion signals win over the worker-crash bucket so a
  // worker that died with a clear OOM message is grouped as out_of_memory.
  if (isOutOfMemoryError(message)) return 'out_of_memory';
  if (isStreamStalledError(message)) return 'geometry_stream_stalled';
  if (isGeometryWorkerCrashError(message)) return 'geometry_worker_crash';
  if (isCancelledError(message)) return 'cancelled';
  return 'unknown';
}

/**
 * Produce a user-facing message for a load failure. Known failure modes get
 * actionable guidance; everything else falls back to the raw error text so we
 * never hide useful detail.
 *
 * @param fileName Optional file name to attribute the failure to.
 */
export function formatLoadError(err: unknown, fileName?: string): string {
  const kind = classifyLoadError(err);
  const subject = fileName ? `"${fileName}"` : 'the model';
  switch (kind) {
    case 'wasm_engine_load':
      return (
        `Couldn't load the 3D geometry engine — a required file failed to download. ` +
        `This usually means the app updated in the background, or a proxy/antivirus blocked it. ` +
        `Please reload the page (Ctrl/Cmd+Shift+R). If it persists, check your network or extensions.`
      );
    case 'out_of_memory':
      return (
        `Ran out of memory while processing ${subject}. ` +
        `Try closing other tabs, or load fewer/smaller models at once.`
      );
    case 'geometry_worker_crash':
      return (
        `A geometry worker stopped unexpectedly while processing ${subject}. ` +
        `This usually means the model is too large for this device's available memory. ` +
        `Try closing other tabs, or load fewer/smaller models at once.`
      );
    case 'geometry_stream_stalled':
      return (
        `Processing ${subject} stalled and was stopped. ` +
        `The model may be too large or complex for this device. ` +
        `Try closing other tabs, or load fewer/smaller models at once.`
      );
    case 'cancelled':
      return `Loading ${subject} was cancelled.`;
    default:
      return `Failed to load ${subject}: ${messageOf(err)}`;
  }
}
