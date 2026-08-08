/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification of model-load failures. The user-facing humanisation lives in
 * ./load-error-message.ts.
 *
 * Despite the name, this is the viewer's ONLY error-family classifier —
 * `analytics-scrub.ts` runs it over every captured `$exception` — so a non-load
 * family needing grouping belongs here too, not in a second one that would drift.
 *
 * The geometry/parser workers both initialise the same `@ifc-lite/wasm` binary.
 * wasm-bindgen's streaming loader rethrows on a non-OK HTTP status (it only
 * falls back for the wrong-MIME case), surfacing as a cryptic `TypeError:
 * Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok` —
 * meaningless to a user and, captured raw, hard to triage. This module maps
 * such failures to a stable `kind` for analytics grouping; `formatLoadError` in
 * ./load-error-message.ts turns that kind into the user-facing message.
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
   * (the per-engine wordings are enumerated on `BARE_TRANSPORT_FAILURE` below).
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
   * caught it: `isWebglContextCreationError` matches only MapLibre's own
   * wordings and the two strings `LocationMap` synthesizes, and
   * `isThreeContextRefusal` only three.js's two authored wordings and the one
   * `three-webgl-support.ts` synthesizes — all of them anchored, so an error
   * that merely MENTIONS the phrase keeps its own identity and its `error`
   * severity.
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

/**
 * A cross-realm throwable reaches the analytics path as `String(err)` — i.e.
 * `"TypeError: Load failed"`, not `"Load failed"`. Structural, so the anchored
 * matchers below tolerate it; BOUNDED, so it cannot stand in for an arbitrary
 * leading sentence of ours that happens to end in "…Error:".
 *
 * `{0,32}`, not `{1,32}`: the commonest constructor is `Error` itself, whose
 * stringification is the bare `Error: Load failed`, and requiring a letter in
 * front excluded exactly that (Codex review, #2431). What does the real work is
 * `[A-Za-z]` admitting no space and no colon — a leading clause of ours can
 * never be swallowed however the count is written.
 */
const STRINGIFIED_ERROR_PREFIX = '(?:[A-Za-z]{0,32}Error:\\s*)?';

/**
 * The user (or a superseding load) cancelled the operation.
 *
 * ANCHORED, because `cancelled` is in `BENIGN_ERROR_KINDS` (./analytics-scrub.ts):
 * matching it downgrades the event to `warning` and fingerprints it into the
 * cancellation issue, taking an actionable failure off the error-level list as
 * effectively as deleting it. The old `/\bcancel(?:led|ed)?\b/` fired on the word
 * ANYWHERE — and, both suffixes optional, on a bare "cancel" — so `Upload failed:
 * driver shim logged cancelled while retrying` read benign (#2410).
 *
 * Shaped differently from the whole-message anchor `isNetworkUnavailableError`
 * uses, because the wordings have a different author: the transport strings
 * come from `fetch()` and ARE the entire message, whereas cancellations are
 * mostly ours and carry authored detail after the token (`Sync cancelled:
 * <model> was removed while its update was downloading.`, `Clash run cancelled
 * before meshing.`). So what is pinned is the SUBJECT — a cancellation report
 * names what was cancelled in its opening words; a failure that merely mentions
 * one reaches the token past a clause of its own. Two arms, because the bare
 * token has no subject to name and so gets no trailing latitude at all
 * (otherwise `cancelled and our upload pipeline then wrote 0 bytes` walks
 * through). The residual, stated plainly: `Upload cancelled and the pipeline
 * wrote 0 bytes` is still read as a cancellation report, because it is one.
 */
const CANCELLED_REPORT = new RegExp(
  `^\\s*${STRINGIFIED_ERROR_PREFIX}(?:`
  + 'cancell?ed\\.?\\s*$'
  // `[^\s:]+` so the subject cannot be reached across a `:` — that separator is
  // what makes "Upload failed: …" a sentence about the upload, not a cancellation.
  + '|(?:[^\\s:]+\\s+){1,2}cancell?ed\\b'
  + ')',
  'i',
);

/**
 * The browsers' own abort wordings — unlike ours these ARE the whole message,
 * so both ends are pinned. `.name === 'AbortError'` already claims the live
 * DOMException in {@link classifyLoadError}; this covers the analytics path,
 * where all we ever have is the stringified value.
 */
const ABORTED_MESSAGE = new RegExp(
  `^\\s*${STRINGIFIED_ERROR_PREFIX}(?:`
  + 'the operation was aborted'          // Gecko
  + '|the user aborted a request'        // Chromium
  + '|fetch is aborted'                  // WebKit
  + '|signal is aborted without reason'  // AbortController with no reason
  + ')\\.?\\s*$',
  'i',
);

function isCancelledError(message: string): boolean {
  // `AbortError` is the stringified NAME — an identity, not prose — so it is
  // anchored to the start rather than matched as a substring anywhere.
  return CANCELLED_REPORT.test(message)
    || /^\s*AbortError\b/.test(message)
    || ABORTED_MESSAGE.test(message);
}

/**
 * A bare transport failure: the request never completed and the browser gave us
 * nothing but its house phrasing. These strings originate inside `fetch()`
 * rather than in our frames, so they arrive with an EMPTY stack — exactly how
 * #1903 reached error tracking as an unattributable `TypeError: Load failed`.
 * Checked LAST, so a failure that named itself (the engine binary, the file, a
 * worker) keeps its own, more actionable kind.
 *
 * ANCHORED AT BOTH ENDS, and that is load-bearing rather than tidiness: this is
 * the most dangerous label in the file. `analytics-scrub.ts` downgrades it to
 * `warning` via `BENIGN_ERROR_KINDS` AND deletes the event outright when the
 * browser also reported `navigator.onLine === false`, so the old substring test
 * meant any failure of ours quoting a transport phrase (`Upload failed: driver
 * shim logged Failed to fetch while retrying`) was silenced, and on an offline
 * client destroyed with no record (#2410). The anchor is exactly the premise
 * stated above — these strings come FROM `fetch()`, so anything wrapping one is
 * by construction ours. A wrapped transport failure now falls to `unknown`:
 * loud, own grouping, the safe direction for a droppable kind.
 *
 * This subsumes what used to be an explicit module-import exclusion: Chromium's
 * `Failed to fetch dynamically imported module: …/assets/Foo-<hash>.js` is our
 * deploy rotating an asset under a still-open tab, not a dropped connection, and
 * it names the module, so it is no longer the whole wording. The guard that said
 * so is gone rather than left as an unreachable branch — `load-errors.test.ts`
 * keeps the regression test as the live gate on this anchor.
 */
const BARE_TRANSPORT_FAILURE = new RegExp(
  `^\\s*${STRINGIFIED_ERROR_PREFIX}(?:`
  // WebKit/Safari, Chromium, Gecko — the generic "fetch rejected" strings.
  + 'load failed'
  + '|failed to fetch'
  // Gecko's full wording is `NetworkError when attempting to fetch resource.`;
  // the noun is optional only because the old matcher keyed on the fragment.
  + '|networkerror when attempting to fetch(?:\\s+resource)?'
  // Darwin's CFNetwork wordings, surfaced verbatim by Safari/WebKit when the
  // connection drops, the device is offline, or DNS cannot resolve the host.
  + '|the network connection was lost'
  + '|the internet connection appears to be offline'
  + '|a server with the specified hostname could not be found'
  + ')\\.?\\s*$',
  'i',
);

function isNetworkUnavailableError(message: string): boolean {
  return BARE_TRANSPORT_FAILURE.test(message);
}

/**
 * The same device refusal, reached through three.js instead of MapLibre.
 *
 * `WebGLRenderer`'s constructor asks the canvas for `webgl2` and throws one of
 * exactly two authored messages when the browser says no (three@0.185.1):
 *
 *   'THREE.WebGLRenderer: Error creating WebGL context.'
 *   'THREE.WebGLRenderer: Error creating WebGL context with your selected attributes.'
 *
 * plus the third that `components/mcp/three-webgl-support.ts` synthesises when
 * its pre-flight probe answers before three is ever constructed — the arm that
 * fires FIRST on a device with no `webgl2`, and therefore the one production
 * mostly sees.
 *
 * Claimed here only because #2401 changed what these mean. #2354 deliberately
 * left them out: back then they escaped a mount effect and took the whole
 * `/mcp` route down through `ChunkErrorBoundary`, and folding a page-killing
 * crash into the benign minimap family would have hidden it. Both `/mcp` scenes
 * now mount behind `useThreeScene`, the only `WebGLRenderer` construction sites
 * in this app, so these strings can only arrive as the handled, one-per-session
 * degradation the minimap already files. Same device condition, same
 * fingerprint, and the same `warning` severity — `webgl_unavailable` is in
 * `BENIGN_ERROR_KINDS`, so this also stops one dead panel competing with real
 * breakage on the error-level list. `context` / `three_surface` still separate
 * the two surfaces inside the issue.
 *
 * ANCHORED, like every matcher here, and STRICTER than
 * `isThreeWebglContextError` in `three-webgl-support.ts`, which prefix-matches:
 * that one decides whether to degrade one panel and is recoverable when it
 * over-matches; this one hands out a shared fingerprint and is not.
 */
const THREE_CONTEXT_REFUSAL = new RegExp(
  '^\\s*THREE\\.WebGLRenderer: Error creating WebGL context'
  + '(?: with your selected attributes)?\\.'
  // The pre-flight suffix, kept in step with `threeProbeFailureError()`. A
  // drift canary in three-webgl-support.test.ts classifies that function's
  // real output, so a reworded probe cannot silently fall out of the family.
  + '(?: \\(pre-flight probe\\))?\\s*$',
);

function isThreeContextRefusal(message: string): boolean {
  return THREE_CONTEXT_REFUSAL.test(message);
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
  if (isWebglContextCreationError(err) || isThreeContextRefusal(message)) {
    return 'webgl_unavailable';
  }
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
