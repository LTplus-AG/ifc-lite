/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU copies of the hovered entity's pieces for the hover pre-highlight mask
 * (#5390). A batched model has no individual mesh for an entity that is not
 * selected, so the hover outline would otherwise never draw.
 *
 * Deliberately kept OUT of `Scene.meshes`: hydrated scene meshes are also
 * drawn by the main pass, so a hovered translucent entity would blend twice
 * over its own batch copy. These copies are only ever drawn into the mask.
 *
 * Every piece of the entity is uploaded (a window or a layered wall is several
 * pieces), through the same uploads selection hydration uses, so the outline
 * is bit-coincident with the batch it traces. An entity above
 * `MERGE_PIECES_ABOVE` pieces uploads merged, since merely moving the pointer
 * over one must not cost a buffer pair per piece (#9192). The copies are
 * rebuilt only when the hovered (model, id) changes, and the previous ones are
 * destroyed then; `release()` frees them when nothing is hovered.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { MERGE_PIECES_ABOVE, uploadIndividualMesh, uploadMergedMeshes, type IndividualMeshFrame, type IndividualMeshGpu } from './individual-mesh-upload.js';

export class HoverMeshCache {
  private key: string | null = null;
  private pieces: IndividualMeshGpu[] = [];

  /**
   * The GPU pieces for `(modelIndex, id)`: cached while the key is unchanged,
   * otherwise `pieces()` is re-read and uploaded. Throws when an upload fails,
   * having freed what it created and cached nothing.
   */
  resolve(
    device: GPUDevice,
    id: number,
    modelIndex: number | undefined,
    pieces: () => readonly MeshData[] | undefined,
    frameOf: (meshData: MeshData) => IndividualMeshFrame,
  ): readonly IndividualMeshGpu[] {
    const key = `${modelIndex ?? 'any'}:${id}`;
    if (key === this.key) return this.pieces;
    this.release();
    const source = pieces() ?? [];
    this.pieces = source.length > MERGE_PIECES_ABOVE
      ? uploadMergedMeshes(device, source, frameOf)
      : uploadEach(device, source, frameOf);
    // Only a finished upload is cached: a throw above leaves no key, so the next
    // frame retries instead of reading an empty result as this hover's pieces.
    this.key = key;
    return this.pieces;
  }

  /** Destroy the cached copies. Idempotent. */
  release(): void {
    for (const piece of this.pieces) {
      piece.vertexBuffer.destroy();
      piece.indexBuffer.destroy();
    }
    this.pieces = [];
    this.key = null;
  }
}

/** One upload per piece, freeing the earlier pieces if a later one throws. */
function uploadEach(device: GPUDevice, source: readonly MeshData[], frameOf: (meshData: MeshData) => IndividualMeshFrame): IndividualMeshGpu[] {
  const uploaded: IndividualMeshGpu[] = [];
  try {
    for (const meshData of source) uploaded.push(uploadIndividualMesh(device, meshData, frameOf(meshData)));
  } catch (error) {
    for (const piece of uploaded) {
      piece.vertexBuffer.destroy();
      piece.indexBuffer.destroy();
    }
    throw error;
  }
  return uploaded;
}
