/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { SceneRecoveryHost } from './scene-device-recovery.js';
import { destroyGpuResources } from './scene-geometry.js';
import { destroyInstancedTemplateGpu } from './scene-instance-types.js';

/** Dispose only handles created by this attempt, never clear a newer CPU load. */
export function restoredGpuRollback(host: SceneRecoveryHost): () => void {
  const batches = host.batchedMeshes.filter(batch => batch.gpuResident !== false);
  const textured = host.texturedMeshes.slice(), templates = host.instancedTemplates.slice();
  const textures = [...host.sharedTextures.values()].map(entry => entry.texture);
  return () => {
    for (const batch of batches) destroyGpuResources(batch);
    for (const mesh of textured) {
      mesh.vertexBuffer.destroy(); mesh.indexBuffer.destroy(); mesh.uniformBuffer.destroy();
    }
    for (const texture of textures) texture.destroy();
    for (const template of templates) if (template) destroyInstancedTemplateGpu(template);
  };
}

/** Private CPU ownership proof, not another geometry ingestion path. */
export function retainedStreamingFragments(host: SceneRecoveryHost): boolean {
  if (!host.streamingFragments.length) return true;
  if (!host.streamedBucketKeys.size) return false;
  const sourceOwners = new Map([...host.meshDataMap].map(([id, pieces]) => [id, new Set(pieces)]));
  const draws = new Set(host.batchedMeshes);
  const counts = new Map<string, number>();
  let retainedIndices = 0, fragmentIndices = 0;
  for (const bucket of host.buckets.values()) for (const piece of bucket.meshData) {
    if (host.meshDataBucket.get(piece) !== bucket || !sourceOwners.get(piece.expressId)?.has(piece)) return false;
    const key = JSON.stringify([piece.modelIndex ?? 0, piece.expressId]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    retainedIndices += piece.indices.length;
  }
  for (const fragment of host.streamingFragments) {
    if (!draws.has(fragment) || !Number.isSafeInteger(fragment.indexCount) || fragment.indexCount <= 0) return false;
    fragmentIndices += fragment.indexCount;
    for (let i = 0; i < fragment.expressIds.length; i++) {
      const key = JSON.stringify([fragment.modelIndices?.[i] ?? 0, fragment.expressIds[i]]);
      const count = counts.get(key) ?? 0;
      if (!count) return false;
      counts.set(key, count - 1);
    }
  }
  return Number.isSafeInteger(retainedIndices) && Number.isSafeInteger(fragmentIndices) && retainedIndices >= fragmentIndices;
}

function properties(value: object): () => boolean {
  // Copy scalar tuples, never vertex/index/IFNS storage. Normal Scene mutations
  // also cross the authored-generation and ownership fences below.
  const entries: Array<[string, unknown]> = Object.entries(value);
  const tuples = entries.map(([, item]) => Array.isArray(item) ? item.slice() : null);
  return () => {
    const current: Array<[string, unknown]> = Object.entries(value);
    return current.length === entries.length && entries.every(([key, item], i) => {
      if (current[i][0] !== key || current[i][1] !== item) return false;
      const tuple = tuples[i];
      return !tuple || Array.isArray(item) && item.length === tuple.length && tuple.every((part, j) => Object.is(part, item[j]));
    });
  };
}

function rows<K, T>(owner: Map<K, T[]>) {
  const entries = [...owner].map(([key, array]) => ({ key, array, values: array.slice() }));
  return (current: Map<K, T[]>) => current === owner && current.size === entries.length
    && entries.every(({ key, array, values }) => current.get(key) === array
      && array.length === values.length && values.every((value, i) => array[i] === value));
}

function bucketPieces(host: SceneRecoveryHost): Map<MeshData, number> {
  // Multiplicity is preserved. A Set here would silently bless lost duplicate
  // source pieces during replacement-device limit repartitioning.
  const pieces = new Map<MeshData, number>();
  for (const bucket of host.buckets.values()) for (const piece of bucket.meshData) pieces.set(piece, (pieces.get(piece) ?? 0) + 1);
  return pieces;
}

function samePieces(expected: Map<MeshData, number>, host: SceneRecoveryHost): boolean {
  const current = bucketPieces(host);
  return current.size === expected.size && [...expected].every(([piece, count]) => current.get(piece) === count);
}

function bucketOwnership(host: SceneRecoveryHost) {
  const owner = host.buckets, reverse = host.meshDataBucket;
  const entries = [...owner].map(([key, bucket]) => ({ key, bucket, array: bucket.meshData, pieces: bucket.meshData.slice() }));
  return () => host.buckets === owner && host.meshDataBucket === reverse && owner.size === entries.length
    && entries.every(({ key, bucket, array, pieces }) => owner.get(key) === bucket && bucket.meshData === array
      && array.length === pieces.length && pieces.every((piece, i) => array[i] === piece && reverse.get(piece) === bucket));
}

/** One token belongs to the existing coalesced Renderer recovery promise.
 * It does not persist a history, allocate an editor, or copy geometry bytes.
 */
export function acquireStreamingRecoveryLease(host: SceneRecoveryHost) {
  if (!host.streamingFragments.length && !host.streamedBucketKeys.size && host.meshQueueReadIndex >= host.meshQueue.length) return null;
  const queue = host.meshQueue, cursor = host.meshQueueReadIndex, prefix = queue.slice();
  const pieces = bucketPieces(host), flat = rows(host.meshDataMap), occurrences = rows(host.instancedEntityMap);
  const templates = host.instancedTemplateCpu, templateRows = templates.slice();
  const sources = new Set<MeshData>([...pieces.keys(), ...prefix]);
  const translations = host.modelTranslations, modelIndices = new Set<number>();
  for (const piece of sources) modelIndices.add(piece.modelIndex ?? 0);
  for (const template of templates) if (template) modelIndices.add(template.modelIndex);
  const poses = [...modelIndices].map(index => ({ index, offset: [...translations.get(index)], yaw: translations.getYaw(index) }));
  // getYaw returns a fresh wrapper: compare its scalar pose, not wrapper refs.
  const posesValid = () => host.modelTranslations === translations && poses.every(({ index, offset, yaw }) => {
    const current = translations.get(index), currentYaw = translations.getYaw(index);
    return offset.every((value, axis) => Object.is(value, current[axis]))
      && yaw?.angle === currentYaw?.angle && yaw?.px === currentYaw?.px && yaw?.pz === currentYaw?.pz;
  });
  // Deduplicating witness checks does not deduplicate output or queue entries.
  const witnesses = [...sources].map(properties);
  for (const template of templates) if (template) witnesses.push(properties(template));
  for (const list of host.instancedEntityMap.values()) for (const occurrence of list) witnesses.push(properties(occurrence));
  let generation = host.authoredGeneration, fragmentOwner = host.streamingFragments;
  let fragments = fragmentOwner.slice(), buckets = bucketOwnership(host);
  let meshes = host.meshes, meshRows = meshes.slice();
  const sourceValid = () => host.authoredGeneration === generation && !host.geometryReleased && !host.ephemeralStreamingMode
    && !host.finalizeInProgress && !host.pendingBatchKeys.size && !host.appearanceController?.hasActiveDrafts()
    && posesValid() && flat(host.meshDataMap) && occurrences(host.instancedEntityMap) && host.instancedTemplateCpu === templates
    && templates.length === templateRows.length && templateRows.every((template, i) => templates[i] === template)
    && witnesses.every(valid => valid()) && host.meshQueue === queue && host.meshQueueReadIndex === cursor
    && host.meshes === meshes && meshes.length === meshRows.length && meshRows.every((mesh, i) => meshes[i] === mesh)
    && queue.length >= prefix.length && prefix.every((piece, i) => queue[i] === piece);
  const valid = () => sourceValid() && buckets() && host.streamingFragments === fragmentOwner
    && fragmentOwner.length === fragments.length && fragments.every((fragment, i) => fragmentOwner[i] === fragment);
  return {
    valid,
    discarded() {
      // Only the owned GPU discard may advance this generation. A concurrent
      // Scene.clear or authoring operation cannot be absorbed as our transition.
      if (host.authoredGeneration !== generation + 1 || host.streamingFragments.length || host.meshes.length) return false;
      generation++;
      fragmentOwner = host.streamingFragments; fragments = [];
      meshes = host.meshes; meshRows = [];
      return valid();
    },
    restored() {
      if (!sourceValid() || !samePieces(pieces, host)) return false;
      // Canonical restoration may repartition CPU buckets for a smaller adapter
      // limit. Accept only that shape change, retaining all physical source rows.
      buckets = bucketOwnership(host);
      return valid();
    },
  };
}
