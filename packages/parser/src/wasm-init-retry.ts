/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resilient one-shot retry around wasm-bindgen's `init()`.
 *
 * wasm-bindgen's streaming loader rethrows on a non-OK HTTP status or a failed
 * fetch of `ifc-lite_bg.wasm` (it only falls back to `arrayBuffer`+`instantiate`
 * for the wrong-MIME case), surfacing as `TypeError: Failed to execute
 * 'compile' on 'WebAssembly': HTTP status code is not ok`. A transient blip — a
 * cold CDN edge, a mid-deploy race, a flaky proxy/antivirus — can produce a
 * one-off failure that a second attempt recovers.
 *
 * Extracted from the worker so it is unit-testable without a real wasm bundle.
 */

/**
 * True when `message` looks like a transient transport/download failure of the
 * engine binary (worth one retry) rather than a genuine corrupt-module or
 * validation error (which must propagate immediately so real bugs aren't
 * masked).
 *
 * Per the WebAssembly Web API, the streaming loader validates the HTTP response
 * (status, MIME, CORS) and rejects with a `TypeError` BEFORE compiling, so only
 * those transport failures are retry-worthy. Invalid bytes (corrupt module,
 * wrong magic header) reject with a `CompileError` — retrying just refetches
 * the same bad bytes, so those fail fast.
 */
export function isTransientWasmLoadError(message: string): boolean {
  // Fail fast on genuine module-validation errors even if a transport-ish word
  // somehow appears in the message.
  if (/compileerror|validation error|magic (?:word|number)|invalid (?:wasm|module)/i.test(message)) {
    return false;
  }
  return /HTTP status code is not ok|failed to fetch|network ?error|load failed/i.test(message);
}

/**
 * A message that already names the thing that failed to load, so re-throwing it
 * with an attribution prefix would only add noise. Deliberately includes
 * `WebAssembly` (the `'compile' on 'WebAssembly'` phrasings) — those are exactly
 * the signatures `isWasmAssetUnavailableError` (wasm-asset-error.ts) matches to
 * drive the #1363 stale-deploy reload, and they must reach it byte-for-byte.
 */
const SELF_IDENTIFYING = /wasm|webassembly/i;

/**
 * A failed *module* load already carries its own specifier. Prefixing one with
 * `ifc-lite_bg.wasm` would make it look to that same #1363 matcher like a
 * rotated ENGINE BINARY (`/\.wasm/` + "dynamically imported module") and
 * trigger a spurious page reload, so those are passed through untouched.
 */
const MODULE_LOAD_FAILURE = /dynamically imported module|module script/i;

/**
 * Name the engine binary in a transport failure that names nothing (issue #1903).
 *
 * wasm-bindgen's generated loader `await`s the `fetch()` it starts, so a
 * network-level rejection propagates RAW: WebKit words it `TypeError: Load
 * failed`, Chromium `TypeError: Failed to fetch`, and because the rejection
 * originates inside the fetch rather than in our frames it carries an EMPTY
 * stack. Two words and no frames is unattributable by construction — the toast,
 * `classifyLoadError` in the viewer, and error tracking all see a bare
 * `TypeError` that could have come from anywhere in the load.
 *
 * So when the final failure identifies nothing, re-throw it naming the binary
 * and the call site, preserving the original as `.cause`. Anything that already
 * identifies itself is returned unchanged.
 */
function attributeEngineLoadFailure(error: unknown, label: string): unknown {
  if (!(error instanceof Error)) return error;
  const msg = error.message;
  if (!isTransientWasmLoadError(msg)) return error;
  if (SELF_IDENTIFYING.test(msg) || MODULE_LOAD_FAILURE.test(msg)) return error;
  return new Error(
    `Failed to load the WASM engine binary (ifc-lite_bg.wasm) in ${label}: ${msg}`,
    { cause: error },
  );
}

export interface InitWasmRetryOptions {
  /** Delay before the single retry. Default 300ms; pass 0 in tests. */
  retryDelayMs?: number;
  /** Injected sleep (tests pass an instant resolver). */
  sleep?: (ms: number) => Promise<void>;
  /** Injected logger (defaults to `console.warn`). */
  warn?: (message: string) => void;
  /** Context label for the log line. */
  label?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `init` once; on a transient-looking failure, wait and retry exactly once.
 * Non-transient failures propagate without a retry. The second failure (if any)
 * propagates to the caller — attributed to the engine binary when the browser's
 * own wording identifies nothing (see {@link attributeEngineLoadFailure}).
 *
 * @param init Thunk that performs the actual `init(...)` call (so callers can
 *   bind their own wasm URL / arguments).
 */
export async function initWasmWithRetry(
  init: () => Promise<unknown>,
  options: InitWasmRetryOptions = {},
): Promise<void> {
  const { retryDelayMs = 300, sleep = defaultSleep, warn = console.warn, label = 'wasm' } = options;
  try {
    await init();
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isTransientWasmLoadError(msg)) throw err;
    warn(`[${label}] WASM engine load failed (${msg}); retrying once`);
    await sleep(retryDelayMs);
    try {
      await init();
    } catch (retryErr) {
      throw attributeEngineLoadFailure(retryErr, label);
    }
  }
}
