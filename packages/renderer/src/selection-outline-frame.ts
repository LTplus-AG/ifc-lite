/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Builds the selection/hover outline pass's per-frame input (#5390) from
 * the meshes the main render pass already drew this frame. Extracted from
 * `index.ts`'s `renderFrame`, which sits close to its module-size budget.
 *
 * Selected meshes reuse their EXISTING uniform buffer/bind group verbatim:
 * `renderFrame`'s highlight-draw loop already wrote the correct
 * view-projection, transform and RTE drawable origin into it earlier in
 * the same frame (before this runs), and GPU queue writes are visible to
 * command buffers submitted in the same `queue.submit` call, in submission
 * order — so no re-pack is needed here.
 *
 * A hovered entity that is not selected has no individual mesh on a batched
 * model, so the caller supplies GPU copies of ALL its pieces
 * (`hover-mesh-cache.ts`); a selected one reuses its selection meshes. Either
 * way every piece is outlined, not just the first. For the copies this packs
 * the fields the mask pipeline reads:
 * view-projection, model transform and RTE drawable origin (vertex
 * position), plus the section plane, clip box and their `flags.y` bits
 * (the mask fragments clip exactly like `fs_main`). It returns the packed
 * floats, not a GPU buffer: `SelectionMaskPass` writes them into the one
 * hover uniform buffer it owns, so hovering allocates nothing per frame.
 *
 * GPU-instanced occurrences (#5745) are not copied at all: the mask draws the
 * templates themselves with `vs_instanced`, and the fragment keeps the
 * selected occurrences (their instance flag) or the hovered id's. This packs
 * the one uniform those draws read: the same frame fields as a hover copy, with
 * an identity model matrix and no drawable origin. `vs_instanced` reads neither; each
 * occurrence's origin comes from its per-instance RTE delta, exactly as in the
 * main instanced colour pass. Packing a stand-in origin of [0, 0, 0] threw once
 * the camera was over 1,000 km from the world origin (#6400).
 */

import { isBorrowedSelection } from './textured-selection.js';
import { highlightBatchOf } from './batch-highlight.js';
import { batchEntityIdAnchor } from './entity-color-table.js';
import { MESH_FLAG_ONE_ENTITY } from './entity-highlight-table.js';
import { packClipBox } from './clip-box.js';
import { MESH_FLAG_RTE_DRAWABLE, MESH_FLAGS_BYTE_OFFSET, MESH_UNIFORM_OFFSET, packRteFragmentSpace } from './mesh-rte-uniforms.js';
import type { RelativeToEyeFrame } from './relative-to-eye.js';
import type { IndividualMeshGpu } from './individual-mesh-upload.js';
import type { HoveredMesh, SelectableMesh } from './selection-mask-pass.js';
import type { InstancedMaskFrame, InstancedMaskTemplate } from './selection-mask-pipelines.js';
import type { InstancedTemplateGPU } from './scene-instance-types.js';
import type { GpuInstancePool } from './gpu-instance-pool.js';
import type { BatchedMesh, ClipBox, ExtraClipPlane, Mesh } from './types.js';

export interface SelectionOutlineSource {
  uniformBufferSize: number;
  viewProj: Float32Array | number[];
  relativeToEyeFrame: RelativeToEyeFrame;
  /** Meshes the highlight-draw loop already prepared this frame (may be empty). */
  selectedMeshes: readonly Mesh[];
  /** GPU copies of the hovered entity's pieces, used when it is not among `selectedMeshes`. */
  hoverPieces: readonly IndividualMeshGpu[];
  /** Colour batches holding the hovered entity, drawn instead of copies when given (#10264 S3). */
  hoverBatches?: readonly BatchedMesh[] | null;
  hoveredId: number | null | undefined;
  selectedModelIndex: number | undefined;
  /** This frame's resolved section plane (the one every mesh draw packs). */
  section: Parameters<typeof packRteFragmentSpace>[1];
  sectionFlipped: boolean | undefined;
  clipBox: ClipBox | null | undefined;
  /** Cutting planes beyond `section` (#7545), world-space. */
  extraPlanes?: readonly ExtraClipPlane[] | null;
  /** This frame's live instanced templates; those with a selected occurrence are outlined (#5745). */
  instancedTemplates?: readonly InstancedTemplateGPU[];
  /** Instanced templates holding an occurrence of `hoveredId` (#5745). */
  instancedHovered?: readonly InstancedMaskTemplate[];
  /** GPU-driven instancing: draw the mask from the pool's compacted streams. */
  instancePool?: GpuInstancePool | null;
}

/**
 * Whether `mesh` is the one `hoveredId` names, honouring the same
 * per-model disambiguation `selectedMeshes` filters by. Pure and exported
 * for unit testing; the two GPU-facing lookups above call it with `.find`.
 * A pooled selection merge (#9835) holds many entities under one id, so it
 * never stands for the hovered one: that entity gets its own hover copies.
 * Nor does a colour batch drawn for the selection (#10264 S3), whose id is
 * only its lane anchor.
 */
export function matchesHoveredMesh(mesh: Mesh, hoveredId: number, selectedModelIndex: number | undefined): boolean {
  return mesh.expressId === hoveredId && !mesh.mergedSelection?.ids && !highlightBatchOf(mesh) && (selectedModelIndex === undefined || mesh.modelIndex === selectedModelIndex);
}

/**
 * Which hover sources a frame needs (#10264 S3). Only a selected hydrated copy
 * outlines every piece of the hovered entity. Authored meshes and textured
 * borrows of a batch-drawn selected entity cover only themselves, so its other
 * pieces still need the hover batches, or hover copies when the batches
 * cannot draw it (a textured entity). Both flags are that one condition.
 */
export function hoverSources(selected: readonly Mesh[], id: number | null, model: number | undefined): { ownHover: boolean; needsBatches: boolean } {
  if (id == null) return { ownHover: false, needsBatches: false };
  const own = !selected.some((m) => m.hydrated === true && matchesHoveredMesh(m, id, model));
  return { ownHover: own, needsBatches: own };
}

function toSelectable(mesh: Mesh): SelectableMesh | null {
  if (!mesh.bindGroup) return null;
  const batch = highlightBatchOf(mesh), quantized = batch?.quantized !== undefined;
  const page = batch?.indexFormat ? batch : undefined; // a compact page grows in place: its current buffers and count
  return { vertexBuffer: page?.vertexBuffer ?? mesh.vertexBuffer, indexBuffer: page?.indexBuffer ?? mesh.indexBuffer, indexCount: page?.indexCount ?? mesh.indexCount, bindGroup: mesh.bindGroup,
    ...(page ? { indexFormat: page.indexFormat } : {}),
    ...(isBorrowedSelection(mesh) ? { vertexStride: 36 as const } : {}), ...(quantized ? { quantized: true as const } : {}) };
}

const IDENTITY_TRANSFORM: Mesh['transform'] = { m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };

/**
 * Packs the per-frame fields every mask draw reads: view-projection, RTE
 * view-projection, section plane, clip box and flags, with an identity model
 * matrix and no drawable origin. Section / clip data go through the same
 * `packClipBox` + `packRteFragmentSpace` pair `index.ts`'s mesh loop uses.
 */
function packMaskFrameUniforms(source: SelectionOutlineSource): Float32Array {
  const scratch = new Float32Array(source.uniformBufferSize / 4);
  scratch.set(source.viewProj, 0);
  scratch.set(IDENTITY_TRANSFORM.m, MESH_UNIFORM_OFFSET.model);
  source.relativeToEyeFrame.packUniforms(scratch, MESH_UNIFORM_OFFSET.rteViewProj);
  const clipBit = packClipBox(source.clipBox, scratch, MESH_UNIFORM_OFFSET.clipBoxMin);
  packRteFragmentSpace(source.relativeToEyeFrame, source.section, source.clipBox, scratch, source.extraPlanes);
  const flags = new Uint32Array(scratch.buffer, MESH_FLAGS_BYTE_OFFSET, 2);
  flags[0] = MESH_FLAG_RTE_DRAWABLE;
  // flags.y: bit 0 = section enabled, bit 1 = flipped, bit 2 = clip box (as index.ts packs it).
  flags[1] = (source.section?.enabled ? 1 : 0) | (source.sectionFlipped ? 2 : 0) | clipBit;
  return scratch;
}

/**
 * Packs the mask pipeline's mesh uniform for a mesh that may not have one
 * yet: the frame fields plus the mesh's model matrix and RTE drawable origin.
 * Exported for unit testing.
 */
export function packHoverUniforms(source: SelectionOutlineSource, mesh: Pick<Mesh, 'transform' | 'rteOrigin'>): Float32Array {
  const scratch = packMaskFrameUniforms(source);
  scratch.set(mesh.transform.m, MESH_UNIFORM_OFFSET.model);
  new Uint32Array(scratch.buffer)[MESH_UNIFORM_OFFSET.overrideParams] = source.hoveredId ?? 0;
  const origin = mesh.rteOrigin ?? [mesh.transform.m[12], mesh.transform.m[13], mesh.transform.m[14]] as [number, number, number];
  source.relativeToEyeFrame.packDrawableOrigin(origin, scratch, MESH_UNIFORM_OFFSET.drawableDelta);
  return scratch;
}

/**
 * The hover mask uniform for a colour batch holding the hovered entity: the
 * frame fields, the batch's origin, quantization and lane anchor, and the one
 * entity the fragment keeps (`MESH_FLAG_ONE_ENTITY`, id in `flags.w`).
 */
export function packBatchHoverUniforms(source: SelectionOutlineSource, batch: BatchedMesh, hoveredId: number): Float32Array | null {
  const scratch = packMaskFrameUniforms(source);
  const origin: [number, number, number] = batch.origin ? [batch.origin[0], batch.origin[1], batch.origin[2]] : [0, 0, 0];
  scratch[MESH_UNIFORM_OFFSET.model + 12] = origin[0];
  scratch[MESH_UNIFORM_OFFSET.model + 13] = origin[1];
  scratch[MESH_UNIFORM_OFFSET.model + 14] = origin[2];
  const q = batch.quantized;
  if (q) scratch.set([q.min[0], q.min[1], q.min[2], q.step], MESH_UNIFORM_OFFSET.quantParams);
  const words = new Uint32Array(scratch.buffer);
  words[MESH_UNIFORM_OFFSET.overrideParams] = batchEntityIdAnchor(batch) ?? 0xFFFFFFFF;
  words[MESH_UNIFORM_OFFSET.flags] |= MESH_FLAG_ONE_ENTITY;
  words[MESH_UNIFORM_OFFSET.flags + 3] = hoveredId >>> 0;
  // Outside the eye envelope the colour pass skips the batch too.
  return source.relativeToEyeFrame.tryPackDrawableOrigin(origin, scratch, MESH_UNIFORM_OFFSET.drawableDelta) ? scratch : null;
}

export interface SelectionOutlineFrameResult {
  selected: SelectableMesh[];
  /** Every piece of the hovered entity (empty when nothing is hovered). */
  hovered: HoveredMesh[];
  /** Instanced occurrences to outline, or null when none are selected or hovered. */
  instanced: InstancedMaskFrame | null;
}

function buildInstancedMaskFrame(source: SelectionOutlineSource): InstancedMaskFrame | null {
  const selected = (source.instancedTemplates ?? []).filter((t) => t.selectedCount > 0);
  const hovered = source.hoveredId != null ? source.instancedHovered ?? [] : [];
  if (selected.length === 0 && hovered.length === 0) return null;
  return {
    uniforms: packMaskFrameUniforms(source),
    rteCamera: source.relativeToEyeFrame.getCameraWorld(),
    selected,
    hovered,
    hoveredId: source.hoveredId ?? 0,
    pool: source.instancePool ?? null,
  };
}

export function buildSelectionOutlineFrame(source: SelectionOutlineSource): SelectionOutlineFrameResult {
  const selected: SelectableMesh[] = [];
  for (const mesh of source.selectedMeshes) {
    const s = toSelectable(mesh);
    if (s) selected.push(s);
  }

  const hovered: HoveredMesh[] = [];
  if (source.hoveredId != null) {
    const hoveredId = source.hoveredId;
    const already = source.selectedMeshes.filter((m) => matchesHoveredMesh(m, hoveredId, source.selectedModelIndex));
    for (const mesh of already) {
      const s = toSelectable(mesh);
      if (s) hovered.push(s);
    }
    // Batches come only when no copy matched (hoverSources): beside any authored meshes of the entity.
    if (source.hoverBatches) {
      for (const batch of source.hoverBatches) {
        const uniforms = packBatchHoverUniforms(source, batch, hoveredId);
        if (uniforms) hovered.push({ vertexBuffer: batch.vertexBuffer, indexBuffer: batch.indexBuffer, indexCount: batch.indexCount, uniforms, ...(batch.indexFormat ? { indexFormat: batch.indexFormat } : {}), ...(batch.quantized ? { quantized: true as const } : {}) });
      }
    } else if (!already.some((m) => m.hydrated === true)) {
      for (const piece of source.hoverPieces) {
        hovered.push({ vertexBuffer: piece.vertexBuffer, indexBuffer: piece.indexBuffer, indexCount: piece.indexCount, uniforms: packHoverUniforms(source, piece) });
      }
    }
  }

  return { selected, hovered, instanced: buildInstancedMaskFrame(source) };
}
