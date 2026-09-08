/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Zone geometry split worker (issue #2508 item 2).
 *
 * Cutting an element against a zone set is an exact arrangement in the CSG
 * kernel, measured at ~357 ms per element through this same wasm build on
 * `AC20-FZK-Haus.ifc` (18 cut elements, 6.4 s in total). On the main thread
 * that is 6.4 seconds with no frames: no spinner turns, the canvas is frozen,
 * and a click anywhere is queued rather than seen. The panel had a
 * `setTimeout(0)` before this existed purely so the disabled state could paint
 * ONCE before the freeze.
 *
 * Only the CUTTING crosses over. The routing decisions - which element is
 * wholly inside, which one the mesher never proved, which zone a piece belongs
 * to - stay on the main thread, because they read the renderer's scene and the
 * store, and shipping either across would be a second copy of state that can
 * disagree with the first.
 *
 * ## What crosses, and what it costs
 *
 * Geometry goes over WITHOUT a transfer list. Transferring would detach the
 * renderer's own buffers and blank the model on screen, so the structured
 * clone's copy is the point rather than an oversight. The pieces come back
 * transferred: those are the worker's own allocations and nothing here reads
 * them again.
 */

import init, * as IfcWasm from '@ifc-lite/wasm';
import {
  splitElementByZones,
  SPLIT_SUM_TOLERANCE_REL,
  type SplitMeshByZonesFn,
  type ZoneMeshPiece,
} from '@/lib/zones/split.js';
import type { Zone } from '@/lib/zones/types.js';

/** One element's geometry as the renderer holds it: positions relative to a
 *  per-mesh origin, which {@link splitElementByZones} folds in itself. */
export interface ZoneSplitJobPiece {
  positions: Float32Array;
  indices: Uint32Array;
  origin?: readonly number[] | null;
}

export interface ZoneSplitJob {
  globalId: number;
  pieces: ZoneSplitJobPiece[];
}

export interface ZoneSplitWorkerRequest {
  type: 'split';
  id: number;
  zones: Zone[];
  /** Which zone's piece the caller wants back. Sending only that one keeps the
   *  reply proportional to what is being exported rather than to the whole
   *  zone set. */
  zoneIndex: number;
  jobs: ZoneSplitJob[];
  tolerance?: number;
}

/** One element's answer. `ok: false` is the splitter's own refusal - the pieces
 *  did not sum to the whole, or the remainder could not be built - and is NOT
 *  the same as `piece: null`, which means this zone simply holds none of it. */
export interface ZoneSplitOutcome {
  globalId: number;
  ok: boolean;
  wholeVolumeM3: number;
  piece: ZoneMeshPiece | null;
}

export type ZoneSplitWorkerResponse =
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'complete'; id: number; outcomes: ZoneSplitOutcome[] }
  | { type: 'error'; id: number; message: string };

/**
 * Run one batch, reporting progress as it goes.
 *
 * Exported so the in-process fallback runs the SAME loop rather than a second
 * implementation of it: a worker-less browser must produce identical files, not
 * merely similar ones.
 */
export function runZoneSplitBatch(
  split: SplitMeshByZonesFn,
  request: Pick<ZoneSplitWorkerRequest, 'zones' | 'zoneIndex' | 'jobs' | 'tolerance'>,
  onProgress?: (done: number, total: number) => void,
): ZoneSplitOutcome[] {
  const tolerance = request.tolerance ?? SPLIT_SUM_TOLERANCE_REL;
  const outcomes: ZoneSplitOutcome[] = [];
  for (const [index, job] of request.jobs.entries()) {
    const result = splitElementByZones(split, job.pieces, request.zones, tolerance);
    outcomes.push(result === null
      ? { globalId: job.globalId, ok: false, wholeVolumeM3: 0, piece: null }
      : {
        globalId: job.globalId,
        ok: true,
        wholeVolumeM3: result.wholeVolumeM3,
        piece: result.pieces.find((p) => p.zoneIndex === request.zoneIndex) ?? null,
      });
    onProgress?.(index + 1, request.jobs.length);
  }
  return outcomes;
}

/** Every buffer in the reply, so the pieces move rather than copy. */
function transferables(outcomes: ZoneSplitOutcome[]): Transferable[] {
  const out: Transferable[] = [];
  for (const outcome of outcomes) {
    if (!outcome.piece) continue;
    out.push(outcome.piece.positions.buffer, outcome.piece.normals.buffer, outcome.piece.indices.buffer);
  }
  return out;
}

/**
 * True only in a real dedicated-worker scope. Guarding the registration keeps
 * this module importable from a test (Node has no `self`, and the in-process
 * fallback imports {@link runZoneSplitBatch} from here) and off `window` if it
 * is ever pulled into a main-thread chunk. Same guard, for the same reasons, as
 * `overlay-parse.worker.ts`.
 */
const isWorkerScope =
  typeof self !== 'undefined' &&
  typeof (globalThis as { window?: unknown }).window === 'undefined' &&
  typeof (self as unknown as Worker).postMessage === 'function';

if (isWorkerScope) {
  self.onmessage = async (event: MessageEvent<ZoneSplitWorkerRequest>) => {
    const request = event.data;
    if (!request || request.type !== 'split') return;
    try {
      // The wasm module has to be compiled in THIS realm: a worker shares no
      // instance with the main thread's.
      await init();
      const split = (IfcWasm as unknown as { splitMeshByZones?: SplitMeshByZonesFn }).splitMeshByZones;
      if (!split) throw new Error('this wasm build has no splitMeshByZones');

      const outcomes = runZoneSplitBatch(split, request, (done, total) => {
        (self as unknown as Worker).postMessage(
          { type: 'progress', id: request.id, done, total } satisfies ZoneSplitWorkerResponse,
        );
      });
      (self as unknown as Worker).postMessage(
        { type: 'complete', id: request.id, outcomes } satisfies ZoneSplitWorkerResponse,
        transferables(outcomes),
      );
    } catch (error) {
      (self as unknown as Worker).postMessage({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      } satisfies ZoneSplitWorkerResponse);
    }
  };
}
