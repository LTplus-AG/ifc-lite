/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export interface InstancedTemplateGPU {
  /** Owning model (federation index). Templates are identified by
   *  `(modelIndex, slot)`, so one model's templates can be freed without
   *  disturbing another's — see `removeInstancedTemplatesForModel`. Defaults to
   *  0, the single-model / primary case. */
  modelIndex: number;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  instanceBuffer: GPUBuffer;
  instanceCount: number;
  /** Union of the occurrences' world AABBs (null when no occurrence has a
   *  finite box — such templates are never culled). Same tuple layout as
   *  BatchedMesh.bounds so the render loop's frustum test is shared. */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Largest single-occurrence bounding-sphere radius (world units). Upper
   *  bound for the contribution cull: no occurrence can project larger than
   *  this radius at the union box's nearest view depth. */
  maxOccRadius: number;
  /** Occurrences currently selected (highlight flag set). A template with a
   *  selected occurrence is exempt from contribution culling so the highlight
   *  can't vanish while the entity is the user's focus. */
  selectedCount: number;
}

/** One occurrence's location in the instanced buffers, for per-instance selection
 *  + colour-override patching. originalColor restores after a lens/IDS overlay clears. */
export interface InstancedOccurrence {
  /** STABLE slot in `instancedTemplates` / `instancedTemplateCpu` — never
   *  reused after the slot is freed, so a stale reference resolves to a hole
   *  rather than to another model's template. */
  templateIndex: number;
  byteOffset: number;
  originalColor: [number, number, number, number];
  /** Originating `IfcRepresentationItem` id (#2985), absent when the shard
   *  carried none. CPU-side by design — see `InstancedRenderTemplate.itemIds`. */
  itemId?: number;
}

/** Compact CPU-side copy of one instanced template, retained so CPU consumers
 *  (bounds / raycast / measure / section / export) can reach instanced geometry
 *  WITHOUT holding a full per-occurrence MeshData each — the occurrences share this
 *  one geometry and apply their own matrix (read from `instanceData` at the
 *  occurrence's byteOffset+0, column-major). These are references into the decoded
 *  shard, so retaining them costs the (already compact) shard size, not N copies. */
export interface InstancedTemplateCpu {
  /** Federation owner copied from the GPU template's model-scoped slot. */
  modelIndex: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  instanceData: ArrayBuffer; // packed 88-byte instance records (mat4 at +0, col-major)
  localMin: [number, number, number];
  localMax: [number, number, number];
}
