/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { copyMeshShell } from '@ifc-lite/geometry/compact';
import type { PrecisionBucket } from './scene-bucket-routing.js';
import type { hashGeometry } from './mesh-geometry-hash.js';
import type { repartitionHydratedRecoveryBucket, SceneRecoveryHost } from './scene-device-recovery.js';
import type { ModelTranslations } from './model-translation.js';
import type { selectEvictions, ResidencyShell } from './residency.js';
import type { SubsetParentResidency } from './scene-subset-residency.js';
import type { BatchedMesh } from './types.js';

interface ColdResidencyDeps {
  selectEvictions: typeof selectEvictions;
  hashGeometry: typeof hashGeometry;
  copyMeshShell: typeof copyMeshShell;
  repartitionHydratedRecoveryBucket: typeof repartitionHydratedRecoveryBucket;
  latticeSuffix: string;
  vertexBytes: number;
}

export interface ColdResidencyHost extends SceneRecoveryHost {
  buckets: Map<string, PrecisionBucket>;
  coldBuckets: Set<string>;
  modelTranslations: SceneRecoveryHost['modelTranslations'] & Pick<ModelTranslations, 'placeMesh' | 'sourceMesh'>;
  residencyFrame: number;
  hostOverBudgetWarned: boolean;
  hostEvictionListeners: Set<() => void>;
  lastDrawnFrame: SceneRecoveryHost['lastDrawnFrame'] & { getAnyUse(id: number): number | undefined };
  fragmentPieces: { forBatch(batch: BatchedMesh): unknown };
  getResidentCpuBytes(): number;
  offLattice: WeakSet<MeshData>;
  subsetResidency: Pick<SubsetParentResidency, 'clear' | 'warmOnly' | 'requeueColdRestore'>;
  baseColorKey(key: string): string;
  addMeshData(mesh: MeshData): void;
  dropPartialCacheForBatch(batch: BatchedMesh): void;
}

function pieceKey(mesh: MeshData, hashGeometry: ColdResidencyDeps['hashGeometry']): string {
  return JSON.stringify([
    mesh.expressId, mesh.modelIndex ?? 0, mesh.geometryItemId, mesh.materialId,
    mesh.geometryClass ?? 0, mesh.origin ?? [0, 0, 0], mesh.color, mesh.occurrenceKey,
    mesh.material?.metallic, mesh.material?.roughness, mesh.localToWorld,
    mesh.positions.length, mesh.normals.length, mesh.indices.length,
    ...hashGeometry(mesh.positions, mesh.normals, mesh.indices),
  ]);
}

/** A bounds read returns entire chunks, including pieces that may have arrived
 * since eviction. Remember the source records in draw order without retaining
 * their CPU buffers. Repeated identical pieces occupy distinct slots. */
export class ColdPieceMembership {
  readonly ids: Set<number>;
  readonly keys: string[];

  constructor(sources: MeshData[], hashGeometry: ColdResidencyDeps['hashGeometry']) {
    this.ids = new Set(sources.map(mesh => mesh.expressId));
    this.keys = sources.map(mesh => pieceKey(mesh, hashGeometry));
  }
}

export function evictColdBuckets(host: ColdResidencyHost, budget: number, deps: ColdResidencyDeps): void {
  const residentBytes = host.getResidentCpuBytes();
  if (residentBytes <= budget) return;

  const shells: ResidencyShell[] = [];
  for (const bucket of host.buckets.values()) {
    const b = bucket.batchedMesh;
    if (!b || b.gpuResident !== false) continue;             // hot buckets stay warm-skippable
    if (bucket.meshData.length === 0) continue;              // already cold
    if (bucket.key.includes('#')) continue;                  // overflow sub-bucket
    if (host.dirtyBuckets.has(bucket.key) || host.fragmentPieces.forBatch(b)) continue; // diverged from disk, or outgrew its batch: a restore keyed by its ids drops the rest (#9270)
    // Colour-merged meshes (per-vertex entityIds) are registered in
    // meshDataMap under EVERY contained id; evicting only the primary id's
    // entry would leave the typed arrays reachable (no memory freed) and a
    // later restore would duplicate the object. Ineligible.
    let colorMerged = false;
    let bytes = 0;
    for (const md of bucket.meshData) {
      if (md.entityIds && md.entityIds.length > 0) { colorMerged = true; break; }
      bytes += md.positions.byteLength + md.normals.byteLength + md.indices.byteLength;
    }
    if (colorMerged) continue;
    shells.push({
      key: bucket.key,
      bytes,
      lastDrawnFrame: host.lastDrawnFrame.getAnyUse(b.id) ?? -1, // a subset on screen keeps its pieces (#9050)
    });
  }
  const evictKeys = deps.selectEvictions(shells, residentBytes, budget, host.residencyFrame);
  let evictedBytes = 0, evicted = false;
  for (const key of evictKeys) {
    const bucket = host.buckets.get(key);
    if (!bucket || bucket.meshData.length === 0) continue;
    bucket.coldMembers = new ColdPieceMembership(bucket.meshData.map(m => host.modelTranslations.sourceMesh(m)), deps.hashGeometry);
    for (const md of bucket.meshData) {
      evictedBytes += md.positions.byteLength + md.normals.byteLength + md.indices.byteLength;
      host.meshDataBucket.delete(md);
      // Remove THIS object from the entity's piece list (identity match:
      // other pieces of the entity may live in other, still-warm buckets).
      const pieces = host.meshDataMap.get(md.expressId);
      if (pieces) {
        const idx = pieces.indexOf(md);
        if (idx >= 0) pieces.splice(idx, 1);
        if (pieces.length === 0) host.meshDataMap.delete(md.expressId);
      }
    }
    bucket.meshData = []; // keeps the pick-geometry revision: these buckets no recent frame recorded drawing (#8998)
    bucket.vertexBytes = 0;
    host.coldBuckets.add(key);
    evicted = true;
  }
  if (evicted) for (const listener of host.hostEvictionListeners) listener();
  if (residentBytes - evictedBytes > budget && !host.hostOverBudgetWarned) {
    host.hostOverBudgetWarned = true;
    console.warn(
      `[Scene] host residency budget ${(budget / 1048576).toFixed(0)}MB exceeded ` +
      `(${((residentBytes - evictedBytes) / 1048576).toFixed(0)}MB CPU resident) — ` +
      `remaining buckets are hot, dirty, or overflow sub-buckets. Rendering is unaffected.`
    );
  }
}

function restoreMembers(membership: ColdPieceMembership, candidates: MeshData[], deps: ColdResidencyDeps): MeshData[] {
  const slots = new Map<string, number[]>();
  membership.keys.forEach((key, index) => {
    const group = slots.get(key);
    if (group) group.push(index);
    else slots.set(key, [index]);
  });
  const members = new Array<MeshData>(membership.keys.length);
  let remaining = members.length;
  for (const mesh of candidates) {
    if (!membership.ids.has(mesh.expressId) || mesh.entityIds?.length) continue;
    const slot = slots.get(pieceKey(mesh, deps.hashGeometry))?.pop();
    if (slot === undefined) continue;
    // A provider may reuse objects across reads. Each placed occurrence
    // needs its own scene identity even when the underlying buffers agree.
    members[slot] = deps.copyMeshShell(mesh);
    if (--remaining === 0) return members;
  }
  return []; // Incomplete read: publish nothing, keep the shell retryable.
}

export function restoreColdBucket(
  host: ColdResidencyHost, key: string, bucket: PrecisionBucket, shell: BatchedMesh, meshes: MeshData[], deps: ColdResidencyDeps,
): void {
  // Re-validate: a clear()/finalize may have replaced the world.
  const current = host.buckets.get(key);
  if (!current || current !== bucket || !host.coldBuckets.has(key)) return;
  const baseKey = host.baseColorKey(key);
  const lattice = baseKey.endsWith(deps.latticeSuffix);
  const members = bucket.coldMembers ? restoreMembers(bucket.coldMembers, meshes, deps) : [];
  for (const source of members) {
    const m = host.modelTranslations.placeMesh(source);
    if (lattice) host.offLattice.add(m);
    bucket.meshData.push(m);
    bucket.vertexBytes += (m.positions.length / 3) * deps.vertexBytes;
    host.meshDataBucket.set(m, bucket);
    host.addMeshData(m);
  }
  if (members.length > 0) {
    delete bucket.coldMembers;
    host.coldBuckets.delete(key);
    const restoredKeys = deps.repartitionHydratedRecoveryBucket(host, key, bucket, shell);
    if (bucket.batchedMesh !== shell) host.dropPartialCacheForBatch(shell); // repartitioned: shell id retired
    host.subsetResidency.requeueColdRestore(key, restoredKeys);
  } else {
    host.subsetResidency.warmOnly.delete(key);
    console.warn(`[Scene] cold restore for ${key} could not match every original piece — bucket stays a shell`);
  }
}
