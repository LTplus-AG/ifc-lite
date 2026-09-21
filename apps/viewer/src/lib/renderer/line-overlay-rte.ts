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
export type AnchoredRendererLineVertices = Exclude<RendererLineVertices, Float32Array>;

const EMPTY_F32 = new Float32Array(0);

/** Convert non-empty f64 world line data into the renderer-owned RTE payload. */
export function anchorWorldLineVertices(vertices: readonly number[]): RendererLineVertices {
  if (vertices.length === 0) return EMPTY_F32;
  if (vertices.length < 3) return new Float32Array(vertices);
  const origin: [number, number, number] = [vertices[0], vertices[1], vertices[2]];
  const localVertices = new Float32Array(vertices.length);
  for (let index = 0; index < vertices.length; index += 3) {
    localVertices[index] = vertices[index] - origin[0];
    localVertices[index + 1] = vertices[index + 1] - origin[1];
    localVertices[index + 2] = vertices[index + 2] - origin[2];
  }
  return { localVertices, origin };
}

/** Return local float data for empty checks and test inspection. */
export function rendererLineVertexData(vertices: RendererLineVertices): Float32Array {
  return vertices instanceof Float32Array ? vertices : vertices.localVertices;
}
