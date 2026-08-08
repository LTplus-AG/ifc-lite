/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification + humanisation of model-load failures.
 *
 * Despite the name, this is the viewer's ONLY error-family classifier —
 * `analytics-scrub.ts` runs it over every captured `$exception` — so a non-load
 * family needing grouping belongs here too, not in a second one that would drift.
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

// Imported, not restated: a second copy of MapLibre's wordings would drift on
// the next upgrade. That module imports nothing, so this adds no dependency.
import { isWebglContextCreationError } from './geo/map-webgl-support.js';

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
   * — WebKit says `Load failed`, Chromium `Failed to fetch`, Gecko
   * `NetworkError when attempting to fetch resource`. The connection dropped,
   * went offline, or was killed mid-flight. Nothing in the app is broken and
   * nothing about the model is wrong, so this is deliberately the LAST bucket
   * checked: any failure that identified itself keeps its own kind.
   */
  | 'network_unavailable'
  /**
   * The browser refused a WebGL context to the location minimap (#2354). Not a
   * load failure and never reaches {@link formatLoadError}; classified so the
   * family gets ONE fingerprint instead of one issue per deploy. Scoped to the
   * failure `LocationMap` catches, latches and degrades around — an UNHANDLED
   * one must never land here (./analytics-scrub.ts, `BENIGN_ERROR_KINDS`).
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

function messageOf(err: unknown): string {
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
const WASM_RUNTIME_UNRECOVERABLE_MARKER = 'WASM_RUNTIME_UNRECOVERABLE'; // == @ifc-lite/geometry's WASM_RUNTIME_UNRECOVERABLE_CODE
function isWasmRuntimeCrashError(err: unknown, message: string): boolean {
  return (
    errorNameOf(err) === 'RuntimeError' || message.includes(WASM_RUNTIME_UNRECOVERABLE_MARKER)
  );
}

function isCancelledError(message: string): boolean {
  return /\bcancel(?:led|ed)?\b|aborterror|the operation was aborted/i.test(message);
}

/**
 * A bare transport failure: the request never completed and the browser gave
 * us nothing but its two-word house phrasing. Because these strings originate
 * inside `fetch()` rather than in our frames, they arrive with an EMPTY stack —
 * which is exactly how #1903 reached error tracking as an unattributable
 * `TypeError: Load failed`.
 *
 * Matched on the engine-specific wording only, and checked LAST, so a failure
 * that named itself (the engine binary, the file, a worker) keeps its own,
 * more actionable kind.
 *
 * A failed *module import* is excluded for the same reason `wasm-init-retry.ts`
 * excludes it from the engine-binary attribution: Chromium words a rotated JS
 * chunk `Failed to fetch dynamically imported module: …/assets/Foo-<hash>.js`,
 * which contains "failed to fetch" but is NOT the user's connection dropping —
 * it is our deployment having rotated an asset under a still-open tab. Bucketing
 * it here would fingerprint it with genuine offline blips AND hand it to the
 * benign-severity downgrade in ./analytics-scrub.ts, silencing a breakage that
 * is ours and that survived `main.tsx`'s one-shot chunk-reload budget. The
 * engine binary's own dynamic-import failure is unaffected: `.wasm` messages are
 * claimed by `isWasmEngineLoadError` above, which runs first.
 */
function isNetworkUnavailableError(message: string): boolean {
  if (/dynamically imported module|importing a module script failed|module script/i.test(message)) {
    return false;
  }
  return (
    // WebKit/Safari, Chromium, Gecko — the generic "fetch rejected" strings.
    /\bload failed\b|failed to fetch|networkerror when attempting to fetch/i.test(message) ||
    // Darwin's CFNetwork wording, surfaced verbatim by Safari/WebKit when the
    // connection drops, the device is offline, or DNS cannot resolve the host.
    /the network connection was lost|internet connection appears to be offline|a server with the specified hostname could not be found/i.test(
      message,
    )
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
  // words those matchers key on ("allocation failed"). Safe to claim first — it
  // takes only MapLibre's authored wordings and its event token, not a name.
  if (isWebglContextCreationError(err)) return 'webgl_unavailable';
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
    case 'file_unreadable':
      return (
        `Couldn't read ${subject} — the file is no longer available to the browser. ` +
        `It may have been moved, renamed, deleted, or unloaded by a cloud-sync client ` +
        `(OneDrive/Dropbox/iCloud) since you picked it. Please select the file again.`
      );
    case 'wasm_runtime_crashed':
      // Two sub-cases, and the difference matters to the user: a trap taken by
      // one operation costs only that operation (the engine rebuilds itself on
      // the next one), while a trap taken while the engine was starting cannot
      // be undone without a new document. Never show the raw engine text here —
      // the reported occurrence put an internal sentence about "recreating the
      // worker process" in front of a user (#1898).
      return messageOf(err).includes(WASM_RUNTIME_UNRECOVERABLE_MARKER)
        ? (
          `The 3D geometry engine crashed and can't restart in this tab. ` +
          `Please reload the page (Ctrl/Cmd+R) — your work in other tabs is unaffected. ` +
          `If it happens again on the same model, it is likely too large for this device's memory.`
        )
        : (
          `The 3D geometry engine crashed while processing ${subject} and the operation was stopped. ` +
          `This is usually memory pressure on a large or complex model — try closing other tabs, ` +
          `or exporting/loading a smaller selection. Reload the page if it keeps happening.`
        );
    case 'cancelled':
      return `Loading ${subject} was cancelled.`;
    case 'network_unavailable':
      return (
        `Couldn't load ${subject}: the connection dropped while downloading. ` +
        `Check your network and try again. Nothing was lost, so loading the same file again is safe.`
      );
    default:
      return `Failed to load ${subject}: ${messageOf(err)}`;
  }
}
