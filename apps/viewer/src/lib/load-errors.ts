/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification of model-load failures. This module owns the taxonomy and the
 * ORDER the buckets are tried in; the user-facing humanisation lives in
 * ./load-error-message.ts, and the two families whose matchers carry more
 * rationale than pattern have their own modules (./webgl-unavailable.ts,
 * ./cancelled-and-network-errors.ts) rather than a longer file here.
 *
 * Despite the name, this is the viewer's ONLY error-family classifier —
 * `analytics-scrub.ts` runs it over every captured `$exception` — so a non-load
 * family needing grouping belongs here too, not in a second one that would
 * drift. The sibling modules are not that: they hold a family's WORDINGS, while
 * every kind and the order it is tried in stays in {@link classifyLoadError}.
 *
 * The geometry/parser workers both initialise the same `@ifc-lite/wasm` binary.
 * wasm-bindgen's streaming loader rethrows on a non-OK HTTP status (it only
 * falls back for the wrong-MIME case), surfacing as a cryptic `TypeError:
 * Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok` —
 * meaningless to a user and, captured raw, hard to triage. This module maps
 * such failures to a stable `kind` for analytics grouping; `formatLoadError` in
 * ./load-error-message.ts turns that kind into the user-facing message.
 */

import { isCancelledError, isNetworkUnavailableError } from './cancelled-and-network-errors.js';
import { isWebglUnavailable } from './webgl-unavailable.js';

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
  /**
   * The browser could not read the file the user picked. The `File`/handle
   * reference was acquired successfully, but the bytes were unreadable by the
   * time we asked for them — the file moved or was deleted, a cloud-sync client
   * evicted it, removable media was unplugged, or an AV/permission change
   * locked it. Nothing about the model is wrong and nothing in the app failed;
   * the user just needs to pick the file again.
   */
  | 'file_unreadable'
  /**
   * The WebAssembly geometry engine trapped at runtime on THIS thread — a Rust
   * panic, a failed `assert!` or an allocator abort, all of which reach JS
   * identically as `RuntimeError: unreachable` (`panic = "abort"`). Distinct
   * from `geometry_worker_crash`, which is the same class of failure inside a
   * worker: there the worker dies and is replaced, here the trap surfaces
   * straight to the caller. Also covers the `WASM_RUNTIME_UNRECOVERABLE`
   * marker, which the engine raises when it trapped while initializing and
   * therefore cannot be rebuilt without a page reload (#1898).
   */
  | 'wasm_runtime_crashed'
  /** The user (or a superseding load) cancelled the operation. */
  | 'cancelled'
  /**
   * A fetch failed at the transport layer and the browser told us nothing else
   * (the per-engine wordings are enumerated on `BARE_TRANSPORT_FAILURE`, in
   * ./cancelled-and-network-errors.ts).
   * The connection dropped, went offline, or was killed mid-flight. Nothing in
   * the app is broken, so this is deliberately the LAST bucket checked: any
   * failure that identified itself keeps its own kind.
   */
  | 'network_unavailable'
  /**
   * The browser refused a WebGL context: to the location minimap (#2354) or to
   * either `/mcp` three.js scene (#2458). Not a load failure and never reaches
   * `formatLoadError`; classified so the family gets ONE fingerprint instead of
   * one issue per deploy and per wording. Membership is by MESSAGE, not by who
   * caught it, and both libraries' wordings live together in
   * ./webgl-unavailable.ts — anchored, so an error that merely MENTIONS one of
   * the phrases keeps its own identity and its `error` severity.
   */
  | 'webgl_unavailable'
  /** Anything else. */
  | 'unknown';

/**
 * A DOMException's `.name` is its STABLE identity; `.message` is
 * engine-specific prose that may not repeat the name at all. Classification
 * that only sees the stringified message therefore misses the very object it
 * is meant to catch on some browsers.
 */
function errorNameOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

/** Exported for ./load-error-message.ts, which needs the same stringification. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * The geometry engine binary (`ifc-lite_bg.wasm`) failed to load. This is a
 * download/compile failure of the WASM module itself, not a problem with the
 * IFC file — the binary 404'd, was served with a non-OK status, was served
 * with the wrong MIME type, or the fetch was blocked (corporate proxy /
 * antivirus / offline). wasm-bindgen's loader cannot recover from a non-OK
 * HTTP status, so it rethrows.
 */
function isWasmEngineLoadError(message: string): boolean {
  return (
    /HTTP status code is not ok/i.test(message) ||
    // `compile`/`compileStreaming`/`instantiate`/`instantiateStreaming` on `WebAssembly`.
    /'(compile|compileStreaming|instantiate|instantiateStreaming)' on 'WebAssembly'/i.test(message) ||
    // Wrong MIME type for the engine binary — a deploy rotated the hashed wasm
    // under an open tab, so the 404 page (text/plain) stands in for it. Firefox
    // phrases this `Response has unsupported MIME type … expected 'application/wasm'`,
    // Chromium `Incorrect response MIME type. Expected 'application/wasm'.` (#1363).
    (/application\/wasm/i.test(message) && /mime|content[- ]?type|unsupported|incorrect|expected/i.test(message)) ||
    // Streaming-fetch failure for the engine binary specifically.
    (/wasm/i.test(message) && /failed to fetch|networkerror|load failed/i.test(message)) ||
    /ifc-lite_bg\.wasm/i.test(message)
  );
}

function isOutOfMemoryError(message: string): boolean {
  return (
    /out of memory|oom|memory access out of bounds|cannot enlarge memory|allocation failed|maximum call stack|array buffer allocation failed|rangeerror: (?:invalid array|array buffer)/i.test(
      message,
    ) ||
    // WebGPU buffer allocation failure. Chromium reports a failed
    // `createBuffer({ mappedAtCreation: true })` as
    //   "createBuffer failed, size (N) is too large for the implementation
    //    when mappedAtCreation == true"
    // and the wording is misleading: the sizes we hit this with are tiny
    // (~190 KB against a device advertising hundreds of MB), because what
    // actually failed is mapping host memory for the new buffer — i.e. memory
    // exhaustion or a device that can no longer service allocations, not a
    // size-limit violation. Grouped with the OOM family because the user
    // guidance is identical.
    /createbuffer failed/i.test(message)
  );
}

/**
 * The picked file could not be read. Every browser surfaces this as a
 * `NotReadableError` DOMException, whose message differs per engine, so match
 * the stable error name first and the phrasing only as a fallback.
 */
function isFileUnreadableError(message: string): boolean {
  return (
    /notreadableerror/i.test(message) ||
    (/could not be read|failed to read/i.test(message) &&
      /permission|file/i.test(message))
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

/**
 * A bare WebAssembly trap that reached us on this thread (#1898). Before this
 * bucket existed such a trap fell through to `unknown`, so the user was shown
 * the raw engine text and error tracking could not group the family at all —
 * which is exactly how the reported occurrence was recorded (`error_kind:
 * unknown`, message = an internal sentence about recreating a worker process).
 *
 * Matched ONLY on hard identity: the error's `.name`, which the spec fixes to
 * `RuntimeError` for every wasm trap and which survives a cross-realm hop where
 * `instanceof` does not, or the engine's explicit unrecoverable marker.
 *
 * Deliberately NOT matched on trap phrasing in the message. Issue #1196 settled
 * that a bare "unreachable" / "RuntimeError: …" *string* must stay `unknown`:
 * on the analytics path (`analytics-scrub`) all we ever have is stringified
 * text, and the viewer runs other wasm (space-plate, parquet) whose traps would
 * then be swept into this family's single issue fingerprint. A live error
 * object carries its `.name`, so nothing real is lost. Checked AFTER the worker
 * bucket so a worker-attributed trap keeps its own bucket.
 */
export const WASM_RUNTIME_UNRECOVERABLE_MARKER = 'WASM_RUNTIME_UNRECOVERABLE'; // == @ifc-lite/geometry's WASM_RUNTIME_UNRECOVERABLE_CODE
function isWasmRuntimeCrashError(err: unknown, message: string): boolean {
  return (
    errorNameOf(err) === 'RuntimeError' || message.includes(WASM_RUNTIME_UNRECOVERABLE_MARKER)
  );
}

/** Classify a load failure into a stable analytics bucket. */
export function classifyLoadError(err: unknown): LoadErrorKind {
  const message = messageOf(err);
  // Checked before the memory/worker buckets: a NotReadableError says nothing
  // about the model or this device's capacity, and its message ("...could not
  // be read...permission problems...") must not be mistaken for one of them.
  // The `.name` check catches the live DOMException regardless of how the
  // browser worded `.message`; the message match covers the analytics path,
  // where all we have is the already-stringified value.
  const name = errorNameOf(err);
  if (name === 'NotReadableError' || isFileUnreadableError(message)) {
    return 'file_unreadable';
  }
  // Same stable-`.name` argument as NotReadableError above: an aborted fetch
  // rejects with a DOMException whose `.message` is engine-specific prose that
  // need not contain the word "abort" at all (WebKit: "Fetch is aborted",
  // Chromium: "The user aborted a request."). Only `.name` is guaranteed.
  if (name === 'AbortError') return 'cancelled';
  // BEFORE the memory/network buckets: MapLibre's failure carries the driver's
  // own `statusMessage`, vendor prose we do not control and free to contain the
  // words those matchers key on ("allocation failed"). Safe to claim first —
  // every arm of it is anchored or structural (see ./webgl-unavailable.ts).
  if (isWebglUnavailable(err, message)) return 'webgl_unavailable';
  if (isWasmEngineLoadError(message)) return 'wasm_engine_load';
  // Explicit memory-exhaustion signals win over the worker-crash bucket so a
  // worker that died with a clear OOM message is grouped as out_of_memory.
  if (isOutOfMemoryError(message)) return 'out_of_memory';
  if (isStreamStalledError(message)) return 'geometry_stream_stalled';
  if (isGeometryWorkerCrashError(message)) return 'geometry_worker_crash';
  if (isWasmRuntimeCrashError(err, message)) return 'wasm_runtime_crashed';
  if (isCancelledError(message)) return 'cancelled';
  // Last of the recognised buckets — see `network_unavailable`'s doc comment.
  if (isNetworkUnavailableError(message)) return 'network_unavailable';
  return 'unknown';
}

/**
 * The discriminating properties every `captureException` call site should send
 * alongside its `context` (issue #1903).
 *
 * SPREAD FLAT onto the event — posthog-js takes the second argument as the
 * event's properties, so nesting these under a wrapper key would bury them in
 * a blob that cannot be filtered or broken down on.
 *
 * Key naming is load-bearing: `scrubProperties` in ./analytics-scrub.ts deletes
 * any key containing a `_`-delimited `name`, `url`, `path`, `message`, … word,
 * so this is `error_type`, never `error_name`, and no URL is ever attached.
 *
 * - `error_kind`  the classified family (see {@link classifyLoadError}); drives
 *                 `$exception_fingerprint` grouping and the severity downgrade.
 * - `error_type`  the throwable's own identity — a DOMException's stable
 *                 `.name`, else the constructor name. The one property that
 *                 survives when the message is two words and the stack empty.
 * - `online`      `navigator.onLine` at capture time, so a user-side outage can
 *                 be told apart from a failure of ours. Omitted where the
 *                 browser doesn't expose it (Node tests).
 */
export function errorCaptureProps(err: unknown): Record<string, unknown> {
  const name = errorNameOf(err);
  const props: Record<string, unknown> = {
    error_kind: classifyLoadError(err),
    // `name` is set on every Error and DOMException; the constructor fallback
    // covers a thrown non-Error (posthog stringifies those, losing even this).
    error_type: name || (err as { constructor?: { name?: string } })?.constructor?.name || typeof err,
  };
  const nav = (globalThis as { navigator?: { onLine?: unknown } }).navigator;
  if (typeof nav?.onLine === 'boolean') props.online = nav.onLine;
  return props;
}
