/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared render-boundary conversion for viewer-produced world-space line
 * overlays. World values remain JavaScript f64 until this function subtracts
 * a source anchor; only the small local residual is materialised as f32.
 */

import type { Renderer } from '@ifc-lite/renderer';

/** Exact payload accepted by Renderer.setLineOverlay; never a look-alike. */
export type RendererLineVertices = Exclude<Parameters<Renderer['setLineOverlay']>[1], null>;
export type AnchoredRendererLineVertices = { localVertices: Float32Array; origin: [number, number, number] };

const EMPTY_F32 = new Float32Array(0);
/** One RTE partition's local f32 extent; larger line segments are split. */
export const MAX_ANCHORED_LINE_EXTENT_METRES = 8_192;

/** Convert non-empty f64 world line data into the renderer-owned RTE payload. */
export function anchorWorldLineVertices(vertices: readonly number[]): RendererLineVertices {
  if (vertices.length === 0) return EMPTY_F32;
  if (vertices.length < 3) return new Float32Array(vertices);
  const partitions: AnchoredRendererLineVertices[] = [];
  for (let index = 0; index + 5 < vertices.length; index += 6) {
    const start: [number, number, number] = [vertices[index], vertices[index + 1], vertices[index + 2]];
    const end: [number, number, number] = [vertices[index + 3], vertices[index + 4], vertices[index + 5]];
    const pieces = Math.max(1, Math.ceil(Math.max(
      Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]), Math.abs(end[2] - start[2]),
    ) / MAX_ANCHORED_LINE_EXTENT_METRES));
    for (let piece = 0; piece < pieces; piece++) {
      const t0 = piece / pieces, t1 = (piece + 1) / pieces;
      const origin: [number, number, number] = [
        start[0] + (end[0] - start[0]) * t0,
        start[1] + (end[1] - start[1]) * t0,
        start[2] + (end[2] - start[2]) * t0,
      ];
      const localVertices = new Float32Array([0, 0, 0,
        (end[0] - start[0]) * (t1 - t0),
        (end[1] - start[1]) * (t1 - t0),
        (end[2] - start[2]) * (t1 - t0)]);
      partitions.push({ localVertices, origin });
    }
  }
  if (partitions.length === 1) return partitions[0];
  return partitions;
}

/** Return local float data for empty checks and test inspection. */
export function rendererLineVertexData(vertices: RendererLineVertices): Float32Array {
  if (vertices instanceof Float32Array) return vertices;
  if ('localVertices' in vertices) return vertices.localVertices;
  const length = vertices.reduce((sum, partition) => sum + partition.localVertices.length, 0);
  const joined = new Float32Array(length);
  let offset = 0;
  for (const partition of vertices) {
    joined.set(partition.localVertices, offset);
    offset += partition.localVertices.length;
  }
  return joined;
}
