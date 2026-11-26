/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The geometry worker's side of compact geometry (`compact-geometry.ts`): the
 * cell size the host asked for, and the payloads each processing session has
 * encoded since its last batch post.
 */

import { compactPayloadTransfers, encodeCompactCollection, isCompactCellSize, type CompactPayload, type CompactWireRef } from './compact-geometry.js';

/** Turn the compact encoder on at this cell size (metres) for the worker's loads; `null` turns it off. */
export interface GeometryWorkerSetCompactGeometryMessage {
  type: 'set-compact-geometry';
  cellSize: number | null;
}

let cellSize: number | null = null;
const pending = new WeakMap<object, CompactPayload[]>();

export function setCompactCellSize(size: number | null): void {
  cellSize = isCompactCellSize(size) ? size : null;
}

/**
 * Encode `collection`'s eligible meshes, before its meshes are read. Returns
 * mesh index -> wire ref, or `undefined` when the encoder is off or took none.
 */
export function encodeSessionCompact(session: { cumulativeMeshBytes: number }, collection: object): Map<number, CompactWireRef> | undefined {
  if (cellSize === null) return undefined;
  let payloads = pending.get(session);
  if (!payloads) pending.set(session, payloads = []);
  const before = payloads.length;
  const rows = encodeCompactCollection(collection, cellSize, payloads);
  // The records are this batch's geometry bytes: the encoded meshes' own arrays are empty.
  for (const payload of payloads.slice(before)) {
    for (const buffer of compactPayloadTransfers(payload)) session.cumulativeMeshBytes += buffer.byteLength;
  }
  return rows;
}

/** Tag the mesh read from collection index `index` with its row, when it was encoded. */
export function tagCompactMesh(meshData: object, rows: Map<number, CompactWireRef> | undefined, index: number): void {
  const wire = rows?.get(index);
  if (wire) (meshData as { compact?: CompactWireRef }).compact = wire;
}

/** The session's payloads for the batch message being posted, their buffers queued on `transfers`. */
export function takeSessionCompact(session: object, transfers: ArrayBuffer[]): { compactBatches?: CompactPayload[] } {
  const payloads = pending.get(session);
  if (!payloads || payloads.length === 0) return {};
  pending.delete(session);
  for (const payload of payloads) transfers.push(...compactPayloadTransfers(payload));
  return { compactBatches: payloads };
}
