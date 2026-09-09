/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { BatchedMesh, Mesh } from './types.js';
import type { InstancedTemplateGPU, TexturedMesh } from './scene.js';
import type { ModelTranslations } from './model-translation.js';
import type { BoundingBox } from './scene-raycaster.js';
import { foldOccurrenceWorldBox, INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import { worldAabbFromPieces } from './scene-geometry.js';

type Triple = [number, number, number];
interface CpuTemplate { instanceData: ArrayBuffer; localMin: Triple; localMax: Triple }
interface TranslationScene {
  translations: ModelTranslations;
  pieces: Map<number, MeshData[]>;
  bounds: Map<number, BoundingBox>;
  batches: BatchedMesh[];
  meshes: Mesh[];
  overrides: BatchedMesh[];
  textured: TexturedMesh[];
  templates: (InstancedTemplateGPU | undefined)[];
  cpu: (CpuTemplate | undefined)[];
  occurrences: Map<number, { templateIndex: number; byteOffset: number }[]>;
  device: GPUDevice | undefined;
  evictHighlight: (id: number) => void;
  clearPartial: () => void;
  unionBounds: (id: number, view: DataView, offset: number, min: Triple, max: Triple) => {
    minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
  };
}

export function translateSceneModel(scene: TranslationScene, modelIndex: number, translation: readonly [number, number, number]): boolean {
  const previous = scene.translations.get(modelIndex);
  if (!scene.translations.set(modelIndex, translation)) return false;
  const releasedIds = new Set<number>();
  for (const batch of scene.batches) {
    if ((batch.modelIndices?.[0] ?? 0) === modelIndex) for (const id of batch.expressIds) releasedIds.add(id);
  }
  for (const mesh of [...scene.textured, ...scene.meshes]) if ((mesh.modelIndex ?? 0) === modelIndex) releasedIds.add(mesh.expressId);
  for (const id of releasedIds) {
    if (scene.pieces.has(id)) continue;
    const box = scene.bounds.get(id);
    const released = scene.translations.releasedEntityBounds(id);
    if (released) scene.bounds.set(id, released);
    else if (box) scene.bounds.set(id, scene.translations.placeReleasedBounds(box, previous, modelIndex));
    scene.evictHighlight(id);
  }
  const seen = new Set<MeshData>();
  for (const [id, pieces] of scene.pieces) {
    if (!pieces.some((piece) => (piece.modelIndex ?? 0) === modelIndex)) continue;
    scene.bounds.delete(id);
    scene.evictHighlight(id);
    for (const piece of pieces) {
      if (seen.has(piece)) continue;
      seen.add(piece);
      scene.translations.placeMesh(piece);
    }
    const flat = worldAabbFromPieces(pieces);
    if (flat) scene.bounds.set(id, flat);
  }
  for (const mesh of scene.meshes) scene.translations.placeAuthoredMesh(mesh);
  for (const mesh of scene.textured) scene.translations.moveDrawable(mesh);
  for (const batch of scene.batches) scene.translations.moveDrawable(batch);
  for (const batch of scene.overrides) scene.translations.moveDrawable(batch);
  scene.clearPartial();
  for (let i = 0; i < scene.templates.length; i++) {
    const gpu = scene.templates[i], cpu = scene.cpu[i];
    if (!gpu || !cpu || gpu.modelIndex !== modelIndex) continue;
    if (scene.translations.placeInstances(cpu.instanceData, modelIndex, INSTANCE_STRIDE_BYTES)) {
      scene.device?.queue.writeBuffer(gpu.instanceBuffer, 0, cpu.instanceData);
    }
    gpu.bounds = null;
  }
  // Visit occurrences once, not once per template. Rebuild the full entity union
  // only after all its matrices have moved (a multi-template entity must not lose pieces).
  for (const [id, occurrences] of scene.occurrences) {
    if (!occurrences.some((occ) => scene.templates[occ.templateIndex]?.modelIndex === modelIndex)) continue;
    const flat = scene.pieces.has(id) ? worldAabbFromPieces(scene.pieces.get(id)!) : scene.translations.releasedEntityBounds(id);
    if (flat) scene.bounds.set(id, flat); else scene.bounds.delete(id);
    scene.evictHighlight(id);
    for (const occ of occurrences) {
      const gpu = scene.templates[occ.templateIndex], cpu = scene.cpu[occ.templateIndex];
      if (!gpu || !cpu) continue;
      const world = scene.unionBounds(id, new DataView(cpu.instanceData), occ.byteOffset, cpu.localMin, cpu.localMax);
      if (gpu.modelIndex === modelIndex) foldOccurrenceWorldBox(gpu, world);
    }
  }
  return true;
}

/** Release template vertices while retaining the occurrence records required for
 * model placement, visibility and bounds in GPU-resident mode. */
export function releaseInstanceVertices(templates: readonly ({ positions: Float32Array; normals: Float32Array; indices: Uint32Array } | undefined)[]): void {
  for (const template of templates) {
    if (!template) continue;
    template.positions = new Float32Array();
    template.normals = new Float32Array();
    template.indices = new Uint32Array();
  }
}

/** Entity edits rewrite textured vertices independently of model origins. */
export function refreshTexturedBounds(translations: ModelTranslations, drawable: TexturedMesh, mesh: MeshData): void {
  const box = worldAabbFromPieces([mesh]);
  drawable.bounds = box ? { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] } : undefined;
  translations.registerDrawable(drawable, drawable.modelIndex ?? 0);
}
