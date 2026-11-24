/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read-only enumeration of the typed arrays of CPU geometry a holder keeps
 * (#10264 S0). Visitors receive the live views, never copies; a caller that
 * wants bytes counts each view's underlying buffer once. Nothing here runs
 * unless a diagnostic asks for it.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { INSTANCE_STRIDE_BYTES } from './instanced-render.js';

export type CpuGeometryKind = 'positions' | 'normals' | 'indices' | 'other';
/** `owner` names the holder (e.g. `scene.buckets`); the same view may arrive under several owners. */
export type CpuGeometryVisitor = (owner: string, array: ArrayBufferView, kind: CpuGeometryKind) => void;

type MeshArrays = Pick<MeshData, 'positions' | 'normals' | 'indices' | 'entityIds' | 'uvs' | 'appearanceSource'>;

/** Visit every typed array one mesh holds. Missing or released (zero-length) arrays are passed as they are. */
export function visitMeshArrays(owner: string, mesh: Partial<MeshArrays>, visit: CpuGeometryVisitor): void {
  if (mesh.positions) visit(owner, mesh.positions, 'positions');
  if (mesh.normals) visit(owner, mesh.normals, 'normals');
  if (mesh.indices) visit(owner, mesh.indices, 'indices');
  if (mesh.entityIds) visit(owner, mesh.entityIds, 'other');
  if (mesh.uvs) visit(owner, mesh.uvs, 'other');
  const source = mesh.appearanceSource;
  if (source) {
    // `indices` normally aliases `mesh.indices`; the caller's buffer dedupe counts it once.
    visit(owner, source.indices, 'indices');
    visit(owner, source.sourceIndices, 'indices');
    if (source.cornerIndices) visit(owner, source.cornerIndices, 'indices');
  }
}

/** The Scene state the walk reads (private fields, read through the usual host cast). */
export interface SceneCpuGeometryHost {
  buckets: Map<string, { meshData: readonly MeshData[] }>;
  meshDataMap: Map<number, readonly MeshData[]>;
  meshQueue: readonly MeshData[];
  meshQueueReadIndex: number;
  instancedTemplateCpu: readonly ((Partial<MeshArrays> & { instanceData?: ArrayBuffer; canonicalAnchors?: Float64Array; canonicalMatrixTranslations?: Float32Array }) | undefined)[];
  texturedMeshes: readonly object[];
  texturedSources: WeakMap<object, { positions: Float32Array; fields: readonly (WeakRef<object> | undefined)[] }>;
  fragmentPieces: { visitMeshes(visit: (mesh: MeshData) => void): void };
  streamWork: { visitMeshes(visit: (mesh?: MeshData, bytes?: ArrayBuffer | Float32Array, salts?: Uint8Array) => void): void };
}

/** Every CPU geometry array a scene references, by holder. A mesh in several holders is visited once per holder. */
export function visitSceneCpuGeometry(scene: SceneCpuGeometryHost, visit: CpuGeometryVisitor): void {
  for (const bucket of scene.buckets.values()) for (const md of bucket.meshData) visitMeshArrays('scene.buckets', md, visit);
  // Colour-merged meshes are listed under every contained id: visit each of those objects once.
  const seen = new Set<MeshData>();
  for (const pieces of scene.meshDataMap.values()) for (const md of pieces) {
    if (md.entityIds?.length) { if (seen.has(md)) continue; seen.add(md); }
    visitMeshArrays('scene.meshDataMap', md, visit);
  }
  for (let i = 0; i < scene.meshQueue.length; i++) visitMeshArrays('scene.meshQueue', scene.meshQueue[i], visit);
  for (const cpu of scene.instancedTemplateCpu) {
    if (!cpu) continue;
    visitMeshArrays('scene.instancedTemplates', cpu, visit);
    // Live records only: an open keyed slot's block has capacity beyond them.
    const live = cpu.canonicalAnchors ? (cpu.canonicalAnchors.length / 3) * INSTANCE_STRIDE_BYTES : cpu.instanceData?.byteLength ?? 0;
    if (cpu.instanceData?.byteLength) visit('scene.instancedTemplates', new Uint8Array(cpu.instanceData, 0, Math.min(live, cpu.instanceData.byteLength)), 'other');
    if (cpu.canonicalAnchors) visit('scene.instancedTemplates', cpu.canonicalAnchors, 'other');
    if (cpu.canonicalMatrixTranslations) visit('scene.instancedTemplates', cpu.canonicalMatrixTranslations, 'other');
  }
  for (const drawable of scene.texturedMeshes) {
    const source = scene.texturedSources.get(drawable);
    if (!source) continue;
    visit('scene.textured', source.positions, 'positions');
    // `captureTexturedSource` order: indices, normals, uvs, entityIds (weakly held: only live ones count).
    const [indices, normals, uvs, entityIds] = source.fields.map((ref) => ref?.deref());
    if (ArrayBuffer.isView(indices)) visit('scene.textured', indices, 'indices');
    if (ArrayBuffer.isView(normals)) visit('scene.textured', normals, 'normals');
    if (ArrayBuffer.isView(uvs)) visit('scene.textured', uvs, 'other');
    if (ArrayBuffer.isView(entityIds)) visit('scene.textured', entityIds, 'other');
  }
  scene.fragmentPieces.visitMeshes(mesh => visitMeshArrays('scene.fragmentPieces', mesh, visit));
  scene.streamWork.visitMeshes((mesh, bytes, salts) => {
    if (mesh) visitMeshArrays('scene.streamWork', mesh, visit);
    if (bytes?.byteLength) visit('scene.streamWork', bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes, 'other');
    if (salts) visit('scene.streamWork', salts, 'other');
  });
}
