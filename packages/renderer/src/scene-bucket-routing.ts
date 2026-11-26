/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { BatchedMesh } from './types.js';
import { BATCH_CONSTANTS } from './constants.js';
import { type TopologyMemo, originPreservesTriangleTopology, topologySafeBatchOrigin } from './scene-precision.js';
import { addLatticeTriangle, emptyLatticeLoss, latticeLoses, latticeNodes, type LatticeLoss } from './quantize.js';
import { writeMergedRecords } from './scene-geometry.js';

export interface PrecisionBucket {
  key: string;
  meshData: MeshData[];
  batchedMesh: BatchedMesh | null;
  vertexBytes: number;
  frameOrigin?: [number, number, number];
}

interface RoutingState {
  buckets: Map<string, PrecisionBucket>;
  activeKeys: Map<string, string>;
  coldKeys: ReadonlySet<string>;
  maxBufferSize: number;
  sharedOrigin: [number, number, number] | undefined;
  /** A mesh `markOffLattice` kept off the ~1 mm lattice: routed to its colour's f32 bucket (#11444). */
  offLattice?(mesh: MeshData): boolean;
  nextSplitKey(): string;
}

/** Suffix of the routing key for meshes the lattice would crumple: their own f32 buckets per colour. */
export const LATTICE_BUCKET_SUFFIX = '#lattice';

/** Reused per-mesh scratch for `markOffLattice`: merged records (7 words per vertex) and lattice nodes. */
let scratchRecords = new ArrayBuffer(0);
let scratchNodes = new Int32Array(0);

/**
 * Add `mesh`'s triangles to `loss`, judged on the f32 records `mergeGeometry`
 * would store for it in `frame`.
 */
function addMeshLatticeLoss(loss: LatticeLoss, mesh: MeshData, frame: readonly [number, number, number]): void {
  const vertexCount = mesh.positions.length / 3;
  if (scratchRecords.byteLength < vertexCount * 28) scratchRecords = new ArrayBuffer(vertexCount * 28);
  if (scratchNodes.length < vertexCount * 3) scratchNodes = new Int32Array(vertexCount * 3);
  const records = new Float32Array(scratchRecords, 0, vertexCount * 7);
  writeMergedRecords(mesh, frame, records, new Uint32Array(scratchRecords, 0, vertexCount * 7), 0);
  const nodes = latticeNodes(records, 7, scratchNodes);
  const { indices } = mesh;
  for (let t = 0; t + 2 < indices.length; t += 3) addLatticeTriangle(loss, records, 7, nodes, indices[t], indices[t + 1], indices[t + 2]);
}

/**
 * Add to `into` the meshes of `meshes` whose entity the lattice would crumple:
 * per entity and bucket colour, the batch gate's rule (`latticeLoses`) over
 * that entity's meshes in this arrival, each judged in `frameOf(mesh)`, the
 * frame a new bucket would give it. Routing then keeps them in an f32 bucket of
 * their colour, so the batch they would have joined still quantizes (#11444).
 * An entity judged in parts (split across arrivals) or in another bucket's
 * frame can still fail the gate there, which keeps that whole batch f32 as
 * before this routing.
 */
export function markOffLattice(
  meshes: readonly MeshData[],
  baseKeyOf: (mesh: MeshData) => string,
  frameOf: (mesh: MeshData) => readonly [number, number, number] | undefined,
  into: WeakSet<MeshData>,
): void {
  const entities = new Map<string, { loss: LatticeLoss; meshes: MeshData[] }>();
  for (const mesh of meshes) {
    const frame = frameOf(mesh);
    if (!frame || mesh.indices.length < 3) continue;
    const key = `${baseKeyOf(mesh)}\u0000${mesh.expressId}`;
    let entity = entities.get(key);
    if (!entity) entities.set(key, entity = { loss: emptyLatticeLoss(), meshes: [] });
    addMeshLatticeLoss(entity.loss, mesh, frame);
    entity.meshes.push(mesh);
  }
  for (const { loss, meshes: parts } of entities.values()) {
    if (latticeLoses(loss)) for (const mesh of parts) into.add(mesh);
  }
}

/**
 * Route by GPU size, by the fixed f32-safe frame chosen for each bucket, and by
 * whether `markOffLattice` kept the mesh off the lattice: such a mesh goes to a
 * bucket of its own colour that stays f32 (the batch gate,
 * `latticeCollapsesGeometry`, judges a whole batch), so its colour neighbours
 * keep their 12-byte records (#11444).
 */
export function resolvePrecisionBucket(
  state: RoutingState,
  colorKey: string,
  mesh: MeshData,
  memo?: TopologyMemo,
): string {
  const baseKey = state.offLattice?.(mesh) ? colorKey + LATTICE_BUCKET_SUFFIX : colorKey;
  let key = state.activeKeys.get(baseKey) ?? baseKey;
  const current = state.buckets.get(key);
  const meshBytes = (mesh.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX;
  const currentOrigin = current?.frameOrigin ?? current?.batchedMesh?.origin;
  const precisionOverflow = (current?.vertexBytes ?? 0) > 0 && currentOrigin !== undefined
    && !(memo ? memo.preserves(mesh, currentOrigin) : originPreservesTriangleTopology([mesh], currentOrigin));
  const sizeOverflow = (current?.vertexBytes ?? 0) > 0
    && (current?.vertexBytes ?? 0) + meshBytes > state.maxBufferSize;

  // Cold buckets are sealed: their empty CPU shell represents disk-backed
  // content and must never absorb a new arrival.
  if ((current && state.coldKeys.has(key)) || sizeOverflow || precisionOverflow) {
    key = state.nextSplitKey();
    state.activeKeys.set(baseKey, key);
  }

  let target = state.buckets.get(key);
  if (!target) {
    const frameOrigin = topologySafeBatchOrigin([mesh], undefined, state.sharedOrigin, undefined, memo);
    // Never publish a bucket which cannot be uploaded without collapsing a
    // valid triangle.  In particular, leaving this undefined used to defer the
    // failure until `mergeGeometry`, after callers had already mutated scene
    // state (and sometimes destroyed the previous batch).
    if (!frameOrigin) {
      throw new Error('Unable to resolve a topology-safe GPU frame for mesh geometry.');
    }
    target = {
      key,
      meshData: [],
      batchedMesh: null,
      vertexBytes: 0,
      frameOrigin,
    };
    state.buckets.set(key, target);
  }
  target.vertexBytes += meshBytes;
  return key;
}
