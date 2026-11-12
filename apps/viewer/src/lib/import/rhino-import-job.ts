/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Rhino (.3dm) import job that `workers/rhinoImport.worker.ts` runs, and
 * the message protocol between it and `rhino-import-client.ts`.
 *
 * The read runs in the worker because it is synchronous wasm: a 400 MB archive
 * holds about 3 GB in the rhino3dm heap and takes seconds. The worker is
 * spawned per load and terminated after, which matters more here than on
 * export: an emscripten `Aborted()` leaves the module unusable, and a fresh
 * worker per load resets it. There is no main-thread fallback.
 *
 * The axis swap into the viewer's Y-up frame also runs here, on the typed
 * arrays that are about to be transferred, so the main thread does no
 * per-vertex work and `@ifc-lite/rhino3dm` stays Z-up and viewer-agnostic.
 *
 * The reader is a dependency rather than an import so a test can drive the
 * real protocol without the rhino3dm runtime — and so this module, which the
 * main-thread client imports for its types, carries no static edge to
 * rhino3dm (`apps/viewer/scripts/check-rhino3dm-lazy.mjs`).
 *
 * Spec: docs/architecture/rhino-3dm-import.md, "Where parsing runs" and
 * "Worker wire format".
 */

import type {
  ReadRhino3dmOptions,
  RhinoImport,
  RhinoImportGeometry,
  RhinoReadErrorCode,
  RhinoVector3,
} from '@ifc-lite/rhino3dm';

/** The reader's codes, plus the one the worker boundary itself can produce. */
export type RhinoImportErrorCode = RhinoReadErrorCode | 'worker-failed';

export interface RhinoImportWorkerRequest {
  type: 'import';
  id: number;
  /** A fresh read of the `File`, transferred: never the loaded store's source view. */
  bytes: Uint8Array;
}

export type RhinoImportWorkerResponse =
  | { type: 'progress'; id: number; done: number; total: number }
  /** `positions`, `normals` and every origin are already viewer Y-up. */
  | { type: 'complete'; id: number; result: RhinoImport }
  | { type: 'error'; id: number; code: RhinoImportErrorCode; message: string };

export interface RhinoImportJobDeps {
  read(bytes: Uint8Array, options: ReadRhino3dmOptions): Promise<RhinoImport>;
}

/**
 * `x, y, z -> x, z, -y` (`ifcToViewerAxes`), in place over an interleaved
 * triple array. `0 - y` rather than `-y` so a zero stays `0`, not `-0`.
 */
function swapTripleArray(values: Float32Array): void {
  for (let i = 0; i < values.length; i += 3) {
    const y = values[i + 1];
    values[i + 1] = values[i + 2];
    values[i + 2] = 0 - y;
  }
}

/** The same rule on one double-precision point. */
function swapPoint(point: RhinoVector3): RhinoVector3 {
  return [point[0], point[2], 0 - point[1]];
}

function swapGeometry(geometry: RhinoImportGeometry): void {
  geometry.origin = swapPoint(geometry.origin);
  swapTripleArray(geometry.positions);
  swapTripleArray(geometry.normals);
}

/**
 * Turn the reader's Z-up result into the viewer's Y-up frame, in place.
 *
 * `definitions` and `instances` are not swapped because the job reads with
 * `bakeInstances`: an instance transform would need conjugating by the swap,
 * and that belongs with the GPU instance path (decision D4), which does not
 * exist yet. An unbaked result reaching here would silently lose geometry, so
 * it is an error rather than a case.
 */
export function swapRhinoImportAxes(result: RhinoImport): void {
  if (result.definitions.length > 0 || result.instances.length > 0) {
    throw new Error('rhino3dm read with bakeInstances returned block definitions');
  }
  for (const mesh of result.meshes) swapGeometry(mesh);
  for (const cloud of result.pointClouds) {
    cloud.origin = swapPoint(cloud.origin);
    swapTripleArray(cloud.positions);
  }
  for (const curve of result.curves) {
    curve.origin = swapPoint(curve.origin);
    swapTripleArray(curve.positions);
  }
  for (const dot of result.textDots) dot.position = swapPoint(dot.position);
}

/** Every buffer the result owns, so one `postMessage` transfers them all. */
function transferableBuffers(result: RhinoImport): Transferable[] {
  const buffers = new Set<ArrayBufferLike>();
  const take = (array: { buffer: ArrayBufferLike } | null) => { if (array) buffers.add(array.buffer); };
  for (const mesh of result.meshes) {
    take(mesh.positions); take(mesh.normals); take(mesh.indices);
  }
  for (const cloud of result.pointClouds) { take(cloud.positions); take(cloud.colors); }
  for (const curve of result.curves) take(curve.positions);
  return [...buffers] as Transferable[];
}

/**
 * The reader throws `RhinoReadError`, which carries a `code` the viewer turns
 * into its own message. Read by shape, not `instanceof`: importing the class
 * would put the rhino3dm runtime in this module's static graph, and the whole
 * point of the dependency injection above is that it is not there.
 */
function errorCode(error: unknown): RhinoImportErrorCode {
  const named = error as { name?: unknown; code?: unknown } | null;
  return named && named.name === 'RhinoReadError' && typeof named.code === 'string'
    ? named.code as RhinoReadErrorCode
    : 'worker-failed';
}

/**
 * Read one archive, posting progress and exactly one `complete` or `error`.
 * Never rejects: a failure becomes an `error` message.
 */
export async function runRhinoImportJob(
  request: RhinoImportWorkerRequest,
  post: (message: RhinoImportWorkerResponse, transfer?: Transferable[]) => void,
  deps: RhinoImportJobDeps,
): Promise<void> {
  const { id } = request;
  try {
    // One message per percent, not per object: every message is a task on the
    // main thread, and a large file has 10^5 objects.
    let lastPercent = -1;
    const result = await deps.read(request.bytes, {
      // Decision D4 is GPU instancing, and `MeshData` has no transform field
      // yet, so the viewer asks for baked blocks until that path exists.
      bakeInstances: true,
      onProgress: (done, total) => {
        const percent = total > 0 ? Math.floor((done * 100) / total) : 100;
        if (percent === lastPercent) return;
        lastPercent = percent;
        post({ type: 'progress', id, done, total });
      },
    });
    swapRhinoImportAxes(result);
    post({ type: 'complete', id, result }, transferableBuffers(result));
  } catch (error) {
    post({ type: 'error', id, code: errorCode(error), message: error instanceof Error ? error.message : String(error) });
  }
}
