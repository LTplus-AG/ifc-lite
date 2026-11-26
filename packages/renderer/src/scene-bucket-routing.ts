/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { BatchedMesh } from './types.js';
import { BATCH_CONSTANTS } from './constants.js';
import { type TopologyMemo, originPreservesTriangleTopology, topologySafeBatchOrigin } from './scene-precision.js';
import { addLatticeTriangle, emptyLatticeLoss, latticeLoses, latticeNodes, type LatticeLoss } from './quantize.js';
import { frameShift } from './scene-geometry.js';

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
  nextSplitKey(): string;
}

/**
 * Last segment of the bucket base key of a mesh `markOffLattice` kept off the
 * ~1 mm lattice: its entity gets f32 buckets of its own colour (#11444). A
 * `~` segment, like the cell and id-page ones, so `#N` split parsing keeps it.
 */
export const LATTICE_KEY_SUFFIX = '~lattice';

/** Reused per-mesh scratch for `markOffLattice`: batch-frame positions and their lattice nodes. */
let scratchPositions = new Float32Array(0);
let scratchNodes = new Int32Array(0);
/** Scratch kept between appends, in floats: a larger one (a huge mesh's) is dropped after use. */
const SCRATCH_KEEP = 1 << 20;

/**
 * Add `mesh`'s triangles to the loss of the entity each belongs to (`lossOf`
 * its lane: `entityIds` per vertex in a colour-merged mesh, as the batch gate
 * reads them, else the mesh's own id), judged on the f32 positions
 * `mergeGeometry` would store for it in `frame` (the same `frameShift`).
 */
function addMeshLatticeLoss(lossOf: (lane: number) => LatticeLoss, mesh: MeshData, frame: readonly [number, number, number]): void {
  const { positions, indices, entityIds } = mesh;
  if (scratchPositions.length < positions.length) {
    scratchPositions = new Float32Array(positions.length);
    scratchNodes = new Int32Array(positions.length);
  }
  const local = scratchPositions.subarray(0, positions.length);
  const shift = frameShift(mesh, frame);
  for (let axis = 0; axis < 3; axis++) {
    for (let i = axis; i < positions.length; i += 3) local[i] = positions[i] + shift[axis];
  }
  const nodes = latticeNodes(local, 3, scratchNodes);
  let lane = -1, loss = emptyLatticeLoss();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const id = entityIds ? entityIds[indices[t]] : mesh.expressId;
    if (id !== lane) { lane = id; loss = lossOf(id); }
    addLatticeTriangle(loss, local, 3, nodes, indices[t], indices[t + 1], indices[t + 2]);
  }
}

/**
 * Add to `into` the meshes of `meshes` that hold an entity the lattice would
 * crumple: per entity and bucket colour, the batch gate's rule
 * (`latticeLoses`) over that entity's triangles in this arrival, each mesh
 * judged in the frame of the bucket it would join (`routeOf`). Their
 * bucket base key then ends in `LATTICE_KEY_SUFFIX`, so they batch apart, in
 * f32, and the batch they would have joined still quantizes (#11444). An
 * entity judged in parts (split across arrivals) or in a frame its batch does
 * not use can still fail the gate there, which keeps that batch f32 as before.
 */
export function markOffLattice(
  meshes: readonly MeshData[],
  routeOf: (mesh: MeshData) => { base: string; frame: readonly [number, number, number] } | undefined,
  into: WeakSet<MeshData>,
): void {
  // Per bucket base, per entity lane: the summed loss and the meshes holding it.
  const bases = new Map<string, Map<number, { loss: LatticeLoss; meshes: MeshData[] }>>();
  for (const mesh of meshes) {
    const route = mesh.indices.length < 3 ? undefined : routeOf(mesh);
    if (!route) continue;
    let entities = bases.get(route.base);
    if (!entities) bases.set(route.base, entities = new Map());
    const lanes = entities;
    addMeshLatticeLoss((lane) => {
      let entity = lanes.get(lane);
      if (!entity) lanes.set(lane, entity = { loss: emptyLatticeLoss(), meshes: [] });
      if (entity.meshes[entity.meshes.length - 1] !== mesh) entity.meshes.push(mesh);
      return entity.loss;
    }, mesh, route.frame);
  }
  for (const entities of bases.values()) {
    for (const { loss, meshes: parts } of entities.values()) {
      if (latticeLoses(loss)) for (const mesh of parts) into.add(mesh);
    }
  }
  if (scratchPositions.length > SCRATCH_KEEP) {
    scratchPositions = new Float32Array(0);
    scratchNodes = new Int32Array(0);
  }
}

/** Route by GPU size and by the fixed f32-safe frame chosen for each bucket. */
export function resolvePrecisionBucket(
  state: RoutingState,
  baseKey: string,
  mesh: MeshData,
  memo?: TopologyMemo,
): string {
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
