/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Rhino (.3dm) export job that `workers/rhinoExport.worker.ts` runs, and
 * the message protocol between it and `rhino-export-client.ts`.
 *
 * Both halves of the export run in the worker: the Rust scene build
 * (`GeometryProcessor.exportRhinoScene`, synchronous wasm that re-meshes the
 * whole model) and the rhino3dm write (synchronous embind calls, then
 * `toByteArray`, measured at about 10 MB/s of output). Either one on the main
 * thread freezes the viewport for seconds to minutes. The worker is spawned
 * per export and terminated after, so the two wasm heaps it grows go back to
 * the OS instead of staying pinned for the session.
 *
 * The job takes its two engines as dependencies so a test can drive the real
 * protocol without either wasm runtime. The worker entry supplies the real ones.
 */

import type { Rhino3dmVersion } from '@ifc-lite/rhino3dm';
import type { RhinoSceneExportOptions } from '@ifc-lite/geometry';
import type { EncodedRhinoScene, Write3dmResult } from '@ifc-lite/rhino3dm';

export interface RhinoExportWorkerRequest {
  type: 'export';
  id: number;
  /** STEP bytes of the model as edited. */
  content: Uint8Array;
  options: RhinoSceneExportOptions;
  version: Rhino3dmVersion;
}

export type RhinoExportWorkerResponse =
  /** Scene build started (indeterminate) or object writing finished and the
   *  archive is being serialized (indeterminate). */
  | { type: 'phase'; id: number; phase: 'scene' | 'serialize' }
  /** Objects written so far. The first one (`done: 0`) ends the scene phase. */
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'complete'; id: number; bytes: Uint8Array; warnings: string[] }
  | { type: 'error'; id: number; message: string };

export interface RhinoExportJobDeps {
  buildScene(content: Uint8Array, options: RhinoSceneExportOptions): Promise<EncodedRhinoScene>;
  writeScene(
    scene: EncodedRhinoScene,
    options: { version: Rhino3dmVersion; onProgress: (done: number, total: number) => void },
  ): Promise<Write3dmResult>;
}

/**
 * Run one export, posting progress and exactly one `complete` or `error`.
 * Never rejects: a failure becomes an `error` message.
 */
export async function runRhinoExportJob(
  request: RhinoExportWorkerRequest,
  post: (message: RhinoExportWorkerResponse, transfer?: Transferable[]) => void,
  deps: RhinoExportJobDeps,
): Promise<void> {
  const { id } = request;
  try {
    post({ type: 'phase', id, phase: 'scene' });
    const scene = await deps.buildScene(request.content, request.options);

    // One message per percent, not per object: a large model has 10^5 objects
    // and every message is a task on the main thread.
    let lastPercent = -1;
    let serializing = false;
    const startSerialize = () => {
      if (serializing) return;
      serializing = true;
      post({ type: 'phase', id, phase: 'serialize' });
    };
    const { bytes, warnings } = await deps.writeScene(scene, {
      version: request.version,
      onProgress: (done, total) => {
        const percent = total > 0 ? Math.floor((done * 100) / total) : 100;
        if (percent !== lastPercent) {
          lastPercent = percent;
          post({ type: 'progress', id, done, total });
        }
        // The writer calls toByteArray right after the last object.
        if (done >= total) startSerialize();
      },
    });

    // Transfer only a buffer the bytes own outright; a view into a larger
    // buffer (for instance wasm memory) is copied first.
    const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
      ? bytes
      : bytes.slice();
    post({ type: 'complete', id, bytes: owned, warnings }, [owned.buffer as ArrayBuffer]);
  } catch (error) {
    post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
}
