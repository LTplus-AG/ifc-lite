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

function isCancelledError(message: string): boolean {
  return /\bcancel(?:led|ed)?\b|aborterror|the operation was aborted/i.test(message);
}

/** Classify a load failure into a stable analytics bucket. */
export function classifyLoadError(err: unknown): LoadErrorKind {
  const message = messageOf(err);
  if (isWasmEngineLoadError(message)) return 'wasm_engine_load';
  if (isOutOfMemoryError(message)) return 'out_of_memory';
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
    case 'cancelled':
      return `Loading ${subject} was cancelled.`;
    default:
      return `Failed to load ${subject}: ${messageOf(err)}`;
  }
}
