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

/**
 * The frame's shared cell: an Int32 ready word, then (from byte 8) Float64
 * x, y, z and the cell size. The pool writes the data, then sets the ready word
 * with Atomics.store; a worker reads the ready word with Atomics.load and only
 * then the data. A worker reads it at every mesh it collects, so the frame
 * applies from the next mesh on even while the worker is inside a long slice
 * and cannot take messages. Wherever the geometry workers run, the pool already
 * shares the source through a SharedArrayBuffer (the parallel path requires
 * it); without one, the `record-frame` message alone delivers the frame.
 */
const CELL_BYTES = 8 + 4 * 8;

export function createRecordFrameCell(): SharedArrayBuffer | null {
  return typeof SharedArrayBuffer === 'undefined' ? null : new SharedArrayBuffer(CELL_BYTES);
}

export function publishRecordFrame(cell: SharedArrayBuffer, known: GpuRecordFrame): void {
  const data = new Float64Array(cell, 8, 4);
  data[0] = known.frame[0]; data[1] = known.frame[1]; data[2] = known.frame[2]; data[3] = known.cellSize;
  Atomics.store(new Int32Array(cell, 0, 1), 0, 1); // last: a reader that sees 1 sees the data
}

export function readRecordFrame(cell: SharedArrayBuffer): GpuRecordFrame | null {
  if (Atomics.load(new Int32Array(cell, 0, 1), 0) !== 1) return null;
  const data = new Float64Array(cell, 8, 4);
  return { frame: [data[0], data[1], data[2]], cellSize: data[3] };
}

/** Pool side: once `source` has a frame, publish it to every worker, once. Polled as batches arrive. */
export function relayRecordFrame(source: (() => GpuRecordFrame | null) | undefined, cell: SharedArrayBuffer | null = source ? createRecordFrameCell() : null): {
  /** Passed with `stream-start`: workers read the frame from it at each mesh. */
  readonly cell: SharedArrayBuffer | null;
  offer(workers: readonly Worker[]): void; count(meshes: readonly { gpuRecords?: unknown }[]): void;
} {
  let sent = !source;
  return {
    cell,
    offer(workers) {
      if (sent) return;
      const known = source!();
      if (!known) { perfCount('geometry.recordFrame.notReady'); return; }
      sent = true;
      perfCount('geometry.recordFrame.sent', workers.length);
      if (cell) publishRecordFrame(cell, known);
      // Also as a message: the path when no shared cell exists, and for a worker without one.
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
const cells = new WeakMap<object, SharedArrayBuffer>();

/** Worker side: the session's shared frame cell, from `stream-start` (absent: messages only). */
export function bindRecordFrameCell(session: object, cell: unknown): void {
  if (cell instanceof SharedArrayBuffer && cell.byteLength >= CELL_BYTES) cells.set(session, cell);
}

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
  let known = frames.get(session);
  if (!known) {
    const cell = cells.get(session);
    const shared = cell ? readRecordFrame(cell) : null;
    if (!shared) return; // not published yet: this mesh takes the main-thread merge, as before
    frames.set(session, (known = shared));
  }
  const records = encodeMeshRecords(mesh, known.frame);
  if (!records) return;
  mesh.gpuRecords = records;
  transfers.push(records.records);
}
