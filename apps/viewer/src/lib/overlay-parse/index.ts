/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Client for {@link ./overlay-parse.worker.ts}. See that file for why these
 * parses must not run on the main thread (#2183).
 *
 * Lifecycle: one worker is shared by every in-flight job so a load that
 * needs both grid and alignment lines pays a single WASM compile, and it is
 * terminated the moment the last job settles. Terminating is the whole
 * point — it is what returns the decode scratch and the never-shrinking
 * `WebAssembly.Memory` to the OS.
 */

import type {
  OverlayLineKind,
  OverlayParseKind,
  OverlayParseRequest,
  OverlayParseResponse,
} from './overlay-parse.worker.js';
import { createEmptyFlatProfiles, type FlatProfiles } from './profiles-flat.js';
import {
  createEmptyFlatSymbolic,
  type FlatSymbolic,
  type SymbolicFilterMode,
} from './symbolic-flat.js';

const EMPTY_F32 = new Float32Array(0);

/**
 * Ceiling on a single parse. Generous on purpose: the parse itself is ~1s for
 * a 342 MB source, so anything near this means the worker is gone rather than
 * slow. It exists because a worker killed by the OS (renderer/worker OOM,
 * the most likely failure mode for exactly the huge-model case this module
 * serves) fires NEITHER `message` nor `error`. Without a deadline that job
 * never settles, `inFlight` never returns to zero, the dead handle is handed
 * to every later job, and overlays stay broken for the rest of the session
 * with nothing in the console.
 */
export const JOB_TIMEOUT_MS = 120_000;

let worker: Worker | null = null;
let nextRequestId = 1;
let inFlight = 0;
const pending = new Map<number, (response: OverlayParseResponse) => void>();

/**
 * Tear the pool down and settle every outstanding job as failed.
 *
 * Terminating here (rather than leaving the worker up) is deliberate. A
 * worker `error` event is not necessarily fatal, so a surviving worker would
 * go on to deliver the real replies for jobs we have already settled empty,
 * and those replies would be silently dropped by `onmessage`. Killing the
 * realm makes the failure unambiguous and gives the next job a clean one.
 *
 * `inFlight` is NOT reset here: each settled job still runs its own `finally`,
 * which decrements it exactly once.
 */
function failAll(message: string): void {
  const outstanding = [...pending];
  pending.clear();
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const [id, resolve] of outstanding) resolve({ id, ok: false, error: message });
}

type WorkerFactory = () => Worker;

function defaultWorkerFactory(): WorkerFactory | null {
  if (typeof Worker === 'undefined') return null;
  return () => new Worker(new URL('./overlay-parse.worker.ts', import.meta.url), {
    type: 'module',
  });
}

let workerFactory: WorkerFactory | null = defaultWorkerFactory();

/**
 * Tests only. Lets a test drive the real handler in-process.
 *
 * Scoped to this module on purpose: installing a global `Worker` instead
 * would make `WorkerParser.isSupported()` believe the PARSER can use workers
 * too, and hand an overlay stub a parse request it cannot answer.
 */
export function __setOverlayWorkerFactoryForTest(
  factory: WorkerFactory | null,
): WorkerFactory | null {
  const previous = workerFactory;
  workerFactory = factory ?? defaultWorkerFactory();
  // Returned so a caller can restore whatever was installed before it, rather
  // than resetting to the default and silently disabling an outer shim.
  return previous;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  if (!workerFactory) throw new Error('no Worker implementation available');
  const created = workerFactory();
  created.onmessage = (event: MessageEvent<OverlayParseResponse>) => {
    const resolve = pending.get(event.data.id);
    if (!resolve) return;
    pending.delete(event.data.id);
    resolve(event.data);
  };
  created.onerror = (event) => {
    failAll(event.message || 'overlay parse worker failed');
  };
  // A reply that cannot be deserialized would otherwise hang its job forever.
  created.onmessageerror = () => {
    failAll('overlay parse worker sent an undeserializable reply');
  };
  worker = created;
  return created;
}

function releaseWorker(): void {
  inFlight--;
  if (inFlight > 0 || !worker) return;
  worker.terminate();
  worker = null;
  pending.clear();
}

/**
 * Parse a whole-source overlay line set off the main thread.
 *
 * Never rejects. Resolves to an empty array on every failure path — worker
 * construction, `postMessage`, a parse error inside the worker, or the worker
 * dying — because these overlays are decoration and a model that cannot
 * produce them must still load.
 */
export async function parseOverlayLines(
  kind: OverlayLineKind,
  source: Uint8Array,
): Promise<Float32Array> {
  const response = await dispatch(kind, source);
  return response && 'verts' in response ? response.verts : EMPTY_F32;
}

/**
 * Parse the symbolic annotations off the main thread.
 *
 * Returns the FLAT primitive stream, not finished buckets: the caller turns it
 * into a `ParseResult` with `buildParseResult`, which keeps the storey lookups
 * and the bucketing logic on the main thread where they already live. See
 * `symbolic-flat.ts`.
 *
 * `mode` picks the owner-type filter: `'overlay'` (the default) for the
 * annotation overlay, `'all'` for the 2D drawing, which draws the symbolic
 * representation of every product type. See {@link SymbolicFilterMode}.
 *
 * Never rejects; resolves to an empty stream on every failure path.
 */
export async function parseSymbolicFlat(
  source: Uint8Array,
  debug = false,
  mode: SymbolicFilterMode = 'overlay',
): Promise<FlatSymbolic> {
  const response = await dispatch('symbolic', source, debug, mode);
  return response && 'flat' in response ? response.flat : createEmptyFlatSymbolic();
}

/**
 * Extract the construction-projection profiles off the main thread.
 *
 * Returns the FLAT entry stream, not finished `ProfileEntry` objects: the
 * caller rebuilds them with `buildProfileEntries`, which keeps the RTC /
 * `originShift` correction on the main thread where `coordinateInfo` lives.
 * See `profiles-flat.ts`.
 *
 * Never rejects; resolves to an empty stream on every failure path.
 */
export async function parseProfilesFlat(source: Uint8Array): Promise<FlatProfiles> {
  const response = await dispatch('profiles', source);
  return response && 'profiles' in response ? response.profiles : createEmptyFlatProfiles();
}

/** Shared request path. Resolves to null on every failure. */
async function dispatch(
  kind: OverlayParseKind,
  source: Uint8Array,
  debug?: boolean,
  mode?: SymbolicFilterMode,
): Promise<Extract<OverlayParseResponse, { ok: true }> | null> {
  if (!workerFactory) return null;
  const id = nextRequestId++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  inFlight++;
  try {
    // `new Worker(...)` and `postMessage` can both throw synchronously (a
    // blocked worker URL, a CSP refusal, a payload the structured-clone
    // algorithm rejects). Those must resolve empty like every other failure
    // here, not reject: callers treat these overlays as decoration and a
    // rejection would surface as an unhandled error during load.
    const response = await new Promise<OverlayParseResponse>((resolve) => {
      const active = ensureWorker();
      pending.set(id, resolve);
      timer = setTimeout(() => {
        if (pending.has(id)) failAll(`overlay parse timed out after ${JOB_TIMEOUT_MS}ms`);
      }, JOB_TIMEOUT_MS);
      const request: OverlayParseRequest = { id, kind, source, debug, mode };
      // Never a transfer list. When the source is SAB-backed (the huge-model
      // path, which requires cross-origin isolation) it is shared by
      // reference and transferring would detach the viewer's own copy. When
      // it is a plain ArrayBuffer (no COI) structured clone copies it into
      // the worker, which is correct but not free.
      active.postMessage(request);
    });
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[overlay-parse] ${kind} failed:`, response.error);
      return null;
    }
    return response;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[overlay-parse] ${kind} could not start:`, error);
    return null;
  } finally {
    clearTimeout(timer);
    pending.delete(id);
    releaseWorker();
  }
}

export { getWholeSourceForWorker } from './source-handoff.js';
export type {
  OverlayParseKind,
  OverlayLineKind,
  FlatProfiles,
  FlatSymbolic,
  SymbolicFilterMode,
};
