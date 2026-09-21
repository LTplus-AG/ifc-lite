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
  for (const coordinate of vertices) {
    if (!Number.isFinite(coordinate)) {
      throw new RangeError(`World line overlay coordinates must be finite; received ${coordinate}.`);
    }
  }
  if (vertices.length < 3) return new Float32Array(vertices);
  const partitions: Array<AnchoredRendererLineVertices & { values: number[] }> = [];

  const fits = (origin: readonly number[], start: readonly number[], end: readonly number[]): boolean =>
    [start, end].every((point) => point.every((coordinate, axis) =>
      Math.abs(coordinate - origin[axis]!) <= MAX_ANCHORED_LINE_EXTENT_METRES,
    ));
  const append = (start: readonly number[], end: readonly number[]): void => {
    // A partition is a spatial batch, rather than a segment. The first fitting
    // anchor preserves source order within that batch while compact survey
    // polylines share one upload/uniform record.
    let partition = partitions.find((candidate) => fits(candidate.origin, start, end));
    if (!partition) {
      partition = { localVertices: EMPTY_F32, origin: [start[0]!, start[1]!, start[2]!], values: [] };
      partitions.push(partition);
    }
    for (const point of [start, end]) {
      partition.values.push(
        point[0]! - partition.origin[0],
        point[1]! - partition.origin[1],
        point[2]! - partition.origin[2],
      );
    }
  };
  for (let index = 0; index + 5 < vertices.length; index += 6) {
    const start: [number, number, number] = [vertices[index], vertices[index + 1], vertices[index + 2]];
    const end: [number, number, number] = [vertices[index + 3], vertices[index + 4], vertices[index + 5]];
    const pieces = Math.max(1, Math.ceil(Math.max(
      Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]), Math.abs(end[2] - start[2]),
    ) / MAX_ANCHORED_LINE_EXTENT_METRES));
    for (let piece = 0; piece < pieces; piece++) {
      const t0 = piece / pieces, t1 = (piece + 1) / pieces;
      const pieceStart: [number, number, number] = [
        start[0] + (end[0] - start[0]) * t0,
        start[1] + (end[1] - start[1]) * t0,
        start[2] + (end[2] - start[2]) * t0,
      ];
      const pieceEnd: [number, number, number] = [
        start[0] + (end[0] - start[0]) * t1,
        start[1] + (end[1] - start[1]) * t1,
        start[2] + (end[2] - start[2]) * t1,
      ];
      append(pieceStart, pieceEnd);
    }
  }
  const result: AnchoredRendererLineVertices[] = partitions.map(({ origin, values }) => ({
    origin,
    localVertices: new Float32Array(values),
  }));
  if (result.length === 1) return result[0];
  return result;
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
