/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU records from the geometry workers (M2). The renderer fixes a model's
 * frame at its first streamed fragment; from then on every worker encodes
 * each mesh it meshes against that frame and its 32 m cell's lattice origin
 * (`encodeMeshRecords`), and the renderer builds a streamed fragment as the
 * concatenation of those records instead of merging and quantizing on the
 * main thread. Meshes meshed before the frame reached their worker, or by a
 * replacement worker, carry no records and take the main-thread merge.
 */
import { perfCount } from '@ifc-lite/load-trace';
import { encodeMeshRecords } from './gpu-records.js';
import type { MeshData } from './types.js';

/** The renderer's frame for a load's streamed fragments, and its chunk cell size. */
export interface GpuRecordFrame {
  frame: [number, number, number];
  cellSize: number;
}

interface RecordFrameMessage extends GpuRecordFrame {
  type: 'record-frame';
}

/** Pool side: once `source` has a frame, post it to every worker, once. Polled as batches arrive. */
export function relayRecordFrame(source: (() => GpuRecordFrame | null) | undefined): { offer(workers: readonly Worker[]): void; count(meshes: readonly { gpuRecords?: unknown }[]): void } {
  let sent = !source;
  return {
    offer(workers) {
      if (sent) return;
      const known = source!();
      if (!known) { perfCount('geometry.recordFrame.notReady'); return; }
      sent = true;
      perfCount('geometry.recordFrame.sent', workers.length);
      const message: RecordFrameMessage = { type: 'record-frame', frame: [known.frame[0], known.frame[1], known.frame[2]], cellSize: known.cellSize };
      for (const worker of workers) worker.postMessage(message);
    },
    /** Per streamed batch: how many meshes arrived with GPU records and how many without (only when records are wired). */
    count(meshes) {
      if (!source) return;
      let withRecords = 0;
      for (const mesh of meshes) if (mesh.gpuRecords) withRecords++;
      perfCount('geometry.records.meshes', withRecords);
      perfCount('geometry.records.missing', meshes.length - withRecords);
    },
  };
}

const frames = new WeakMap<object, GpuRecordFrame>();

/** Worker side: take a `record-frame` message for the active session. True when `data` was one. */
export function acceptRecordFrame(session: object | null, data: unknown): boolean {
  const message = data as Partial<RecordFrameMessage> | null;
  if (message?.type !== 'record-frame') return false;
  const { frame, cellSize } = message;
  if (session && frame?.length === 3 && frame.every(Number.isFinite) && typeof cellSize === 'number' && cellSize > 0) {
    frames.set(session, { frame: [frame[0], frame[1], frame[2]], cellSize });
  }
  return true;
}

/** Worker side: encode a just-meshed mesh's records for its session's frame, and transfer them with it. */
export function attachGpuRecords(session: object, mesh: MeshData, transfers: ArrayBuffer[]): void {
  const known = frames.get(session);
  if (!known) return;
  const records = encodeMeshRecords(mesh, known.frame);
  if (!records) return;
  mesh.gpuRecords = records;
  transfers.push(records.records);
}
