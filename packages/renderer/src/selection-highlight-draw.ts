/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selection highlight draw: after every other mesh of the main pass, so
 * transparent batches cannot paint over it (glass would otherwise read
 * unhighlighted). Three kinds of draw share it, each through the selection
 * pipeline (no depth write, `greater-equal`, coincident with its base):
 *
 * - copies built from CPU pieces (`selection-hydration.ts`);
 * - textured pieces' own buffers (`textured-selection.ts`);
 * - colour batches drawn whole, keeping only the highlighted entities
 *   (`batch-highlight.ts`, #10264 S3). These also carry their quantization
 *   and their lane anchor, as the colour pass draws them.
 */

import { highlightBatchOf, stageBatchHighlight } from './batch-highlight.js';
import { batchEntityIdAnchor } from './entity-color-table.js';
import { MESH_FLAG_HIGHLIGHTED_ENTITIES } from './entity-highlight-table.js';
import { packMeshMaterial } from './mesh-material.js';
import { MESH_FLAG_RTE_DRAWABLE, MESH_UNIFORM_OFFSET, packRteFragmentSpace, packSectionPlaneLanes } from './mesh-rte-uniforms.js';
import { ensureMeshUniform } from './mesh-uniform-resources.js';
import type { RenderPipeline } from './pipeline.js';
import type { RelativeToEyeFrame } from './relative-to-eye.js';
import { isBorrowedSelection, stageBorrowedSelection } from './textured-selection.js';
import type { BatchedMesh, ClipBox, ExtraClipPlane, Mesh } from './types.js';

export interface HighlightDrawFrame {
  pass: GPURenderPassEncoder;
  device: GPUDevice;
  pipeline: Pick<RenderPipeline, 'getUniformBufferSize' | 'getBindGroupLayout' | 'getSelectionPipeline' | 'getTexturedSelectionPipeline' | 'getBatchSelectionPipeline'>;
  usePipeline(pipeline: GPURenderPipeline): void;
  /** The frame's shared uniform template, its flags lanes and its override lanes. */
  tpl: Float32Array;
  tplFlags: Uint32Array;
  overrideU32: Uint32Array;
  viewProj: Float32Array | number[];
  section: Parameters<typeof packRteFragmentSpace>[1];
  sectionFlipped: boolean;
  clipBit: number;
  clipBox: ClipBox | null | undefined;
  extraPlanes: readonly ExtraClipPlane[];
  relativeToEyeFrame: RelativeToEyeFrame;
  /** Keeps a borrowed batch resident through this frame's submit. */
  onBatchDrawn(batch: BatchedMesh): void;
}

/** Draw the highlight meshes; returns the draw calls issued. */
export function drawSelectionHighlights(meshes: readonly Mesh[], f: HighlightDrawFrame): number {
  const { tpl, tplFlags, pass } = f;
  let draws = 0;
  for (const mesh of meshes) ensureMeshUniform(f.device, f.pipeline, mesh);
  for (const mesh of meshes) {
    if (!mesh.bindGroup || !mesh.uniformBuffer) continue;
    const batch = highlightBatchOf(mesh);
    const pipeline = batch ? f.pipeline.getBatchSelectionPipeline(batch.quantized !== undefined)
      : isBorrowedSelection(mesh) ? f.pipeline.getTexturedSelectionPipeline() : f.pipeline.getSelectionPipeline();
    if (!pipeline) continue; // a batch record is only made while its pipeline exists

    tpl.set(f.viewProj, 0);
    tpl.set(mesh.transform.m, 16);
    tpl[32] = mesh.color[0]; tpl[33] = mesh.color[1];
    tpl[34] = mesh.color[2]; tpl[35] = mesh.color[3];
    packMeshMaterial(tpl, mesh.color[3], mesh.finish ?? mesh.material);
    packSectionPlaneLanes(f.section, tpl);
    tplFlags[0] = 1; // isSelected
    tplFlags[1] = (f.section?.enabled ? 1 : 0) | (f.sectionFlipped ? 2 : 0) | f.clipBit;
    tplFlags[2] = 0;
    tplFlags[3] = 0;
    packRteFragmentSpace(f.relativeToEyeFrame, f.section, f.clipBox, tpl, f.extraPlanes);
    const origin = mesh.rteOrigin ?? [mesh.transform.m[12], mesh.transform.m[13], mesh.transform.m[14]] as [number, number, number];
    if (!f.relativeToEyeFrame.tryPackDrawableOrigin(origin, tpl, MESH_UNIFORM_OFFSET.drawableDelta)) continue;
    tplFlags[0] |= MESH_FLAG_RTE_DRAWABLE | (batch ? MESH_FLAG_HIGHLIGHTED_ENTITIES : 0);
    const q = batch?.quantized;
    tpl[56] = q ? q.min[0] : 0; tpl[57] = q ? q.min[1] : 0; tpl[58] = q ? q.min[2] : 0; tpl[59] = q ? q.step : 0;

    // A copy names its entity; a batch names its lane anchor, from which the shader rebuilds full ids.
    f.overrideU32[0] = batch ? batchEntityIdAnchor(batch) ?? 0xFFFFFFFF : mesh.expressId;
    if (!stageBatchHighlight(mesh, tpl) && !stageBorrowedSelection(mesh, tpl)) f.device.queue.writeBuffer(mesh.uniformBuffer, 0, tpl);
    if (batch) f.onBatchDrawn(batch);

    f.usePipeline(pipeline);
    pass.setBindGroup(0, mesh.bindGroup);
    pass.setVertexBuffer(0, mesh.vertexBuffer);
    pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
    pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
    draws++;
  }
  return draws;
}
