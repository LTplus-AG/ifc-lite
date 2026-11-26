/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drawing input that need not be one resident mesh array (#10264).
 *
 * `Drawing2DGenerator.generateFromSource` reads its meshes in at most two
 * passes over a source and keeps none of them: each batch is cut, projected
 * or rasterized while it is current, then only 2D output (segments, lines,
 * one depth raster) and per-entity free-edge parity survive it. A source may
 * therefore lease a batch from storage and release it as soon as the
 * generator advances the iterator; no pass ever needs the whole model at once.
 *
 * Passes, in order:
 * - `geometry`: section cut and construction projection;
 * - `occlusion`: only when needed, the hidden-line depth raster and the
 *   free-edge test of entities whose cut left open chains.
 * Every pass must yield the same meshes, in the same order, as the first: a
 * source that cannot (its geometry changed between passes) must throw rather
 * than yield different geometry. The output equals `generate` over the
 * concatenation of one pass's batches.
 */

import type { MeshData } from '@ifc-lite/geometry';

export type DrawingPass = 'geometry' | 'occlusion';

export interface DrawingMeshSource {
  /** One complete, ordered pass over the drawing's meshes, in batches. */
  pass(pass: DrawingPass): AsyncIterable<readonly MeshData[]>;
}

/** A resident mesh array as a source: every pass yields it as one batch. */
export function meshArraySource(meshes: readonly MeshData[]): DrawingMeshSource {
  return {
    async *pass() {
      if (meshes.length > 0) yield meshes;
    },
  };
}
