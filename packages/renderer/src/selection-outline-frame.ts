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
 * The hovered mesh usually has no uniform buffer yet (it is not
 * necessarily selected), so this packs the fields the mask pipeline reads:
 * view-projection, model transform and RTE drawable origin (vertex
 * position), plus the section plane, clip box and their `flags.y` bits
 * (the mask fragments clip exactly like `fs_main`). It returns the packed
 * floats, not a GPU buffer: `SelectionMaskPass` writes them into the one
 * hover uniform buffer it owns, so hovering allocates nothing per frame.
 */

import { packClipBox } from './clip-box.js';
import { MESH_FLAG_RTE_DRAWABLE, MESH_FLAGS_BYTE_OFFSET, MESH_UNIFORM_OFFSET, packRteFragmentSpace } from './mesh-rte-uniforms.js';
import type { RelativeToEyeFrame } from './relative-to-eye.js';
import type { HoveredMesh, SelectableMesh } from './selection-mask-pass.js';
import type { ClipBox, Mesh } from './types.js';

export interface SelectionOutlineSource {
  uniformBufferSize: number;
  viewProj: Float32Array | number[];
  relativeToEyeFrame: RelativeToEyeFrame;
  /** Meshes the highlight-draw loop already prepared this frame (may be empty). */
  selectedMeshes: readonly Mesh[];
  /** All meshes drawn this frame, searched for the hovered id if it is not already selected. */
  allMeshes: readonly Mesh[];
  hoveredId: number | null | undefined;
  selectedModelIndex: number | undefined;
  /** This frame's resolved section plane (the one every mesh draw packs). */
  section: Parameters<typeof packRteFragmentSpace>[1];
  sectionFlipped: boolean | undefined;
  clipBox: ClipBox | null | undefined;
}

/**
 * Whether `mesh` is the one `hoveredId` names, honouring the same
 * per-model disambiguation `selectedMeshes` filters by. Pure and exported
 * for unit testing; the two GPU-facing lookups above call it with `.find`.
 */
export function matchesHoveredMesh(mesh: Mesh, hoveredId: number, selectedModelIndex: number | undefined): boolean {
  return mesh.expressId === hoveredId && (selectedModelIndex === undefined || mesh.modelIndex === selectedModelIndex);
}

function toSelectable(mesh: Mesh): SelectableMesh | null {
  if (!mesh.bindGroup) return null;
  return { vertexBuffer: mesh.vertexBuffer, indexBuffer: mesh.indexBuffer, indexCount: mesh.indexCount, bindGroup: mesh.bindGroup };
}

/**
 * Packs the mask pipeline's mesh uniform for a mesh that may not have one
 * yet. Exported for unit testing; section / clip data go through the same
 * `packClipBox` + `packRteFragmentSpace` pair `index.ts`'s mesh loop uses.
 */
export function packHoverUniforms(source: SelectionOutlineSource, mesh: Mesh): Float32Array {
  const scratch = new Float32Array(source.uniformBufferSize / 4);
  scratch.set(source.viewProj, 0);
  scratch.set(mesh.transform.m, 16);
  source.relativeToEyeFrame.packUniforms(scratch, MESH_UNIFORM_OFFSET.rteViewProj);
  const origin = mesh.rteOrigin ?? [mesh.transform.m[12], mesh.transform.m[13], mesh.transform.m[14]] as [number, number, number];
  source.relativeToEyeFrame.packDrawableOrigin(origin, scratch, MESH_UNIFORM_OFFSET.drawableDelta);
  const clipBit = packClipBox(source.clipBox, scratch, MESH_UNIFORM_OFFSET.clipBoxMin);
  packRteFragmentSpace(source.relativeToEyeFrame, source.section, source.clipBox, scratch);
  const flags = new Uint32Array(scratch.buffer, MESH_FLAGS_BYTE_OFFSET, 2);
  flags[0] = MESH_FLAG_RTE_DRAWABLE;
  // flags.y: bit 0 = section enabled, bit 1 = flipped, bit 2 = clip box (as index.ts packs it).
  flags[1] = (source.section?.enabled ? 1 : 0) | (source.sectionFlipped ? 2 : 0) | clipBit;
  return scratch;
}

export interface SelectionOutlineFrameResult {
  selected: SelectableMesh[];
  hovered: HoveredMesh | null;
}

export function buildSelectionOutlineFrame(source: SelectionOutlineSource): SelectionOutlineFrameResult {
  const selected: SelectableMesh[] = [];
  for (const mesh of source.selectedMeshes) {
    const s = toSelectable(mesh);
    if (s) selected.push(s);
  }

  let hovered: HoveredMesh | null = null;
  if (source.hoveredId != null) {
    const hoveredId = source.hoveredId;
    const already = source.selectedMeshes.find((m) => matchesHoveredMesh(m, hoveredId, source.selectedModelIndex));
    if (already) {
      hovered = toSelectable(already);
    } else {
      const found = source.allMeshes.find((m) => matchesHoveredMesh(m, hoveredId, source.selectedModelIndex));
      if (found) hovered = { vertexBuffer: found.vertexBuffer, indexBuffer: found.indexBuffer, indexCount: found.indexCount, uniforms: packHoverUniforms(source, found) };
    }
  }

  return { selected, hovered };
}
