/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renderer-agnostic point cloud types.
 *
 * Decoders in this package produce DecodedPointChunks; the renderer (and
 * any other consumer) shapes them into GPU buffers. No WebGPU, no three.js.
 */

export interface PointCloudBBox {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * A decoded chunk of points ready for upload to a GPU buffer.
 *
 * Coordinates are in the source's native space. Any z-up→y-up swap and
 * RTC offset is the renderer's responsibility (it already owns those for
 * triangle meshes). Optional 4x4 transform on the asset is applied per-vertex
 * in the vertex shader.
 *
 * Color channel layout: 0..1 floats per channel. RGB only — alpha is solid.
 * Classification (LAS-style) is a per-point u8.
 */
export interface DecodedPointChunk {
  /** [x,y,z, x,y,z, ...] */
  positions: Float32Array;
  /** [r,g,b, r,g,b, ...] in 0..1 — undefined when source has no color */
  colors?: Float32Array;
  /** Per-point u8 classification — undefined when source has none */
  classifications?: Uint8Array;
  /** Number of points in this chunk (positions.length / 3) */
  pointCount: number;
  /** Local bbox of this chunk's positions (pre-transform) */
  bbox: PointCloudBBox;
}
