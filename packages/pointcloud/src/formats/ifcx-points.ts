/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Decoders for the two non-PCD IFCx point cloud schemas authored by
 * buildingSMART:
 *
 *   points::array  — { positions: number[][], colors?: number[][] }
 *                    inline JSON arrays of [x,y,z] and [r,g,b] in 0..1
 *
 *   points::base64 — { positions: base64-string, colors?: base64-string }
 *                    little-endian Float32 buffers, [x,y,z, x,y,z, ...]
 *                    and [r,g,b, r,g,b, ...] in 0..1
 *
 * The PCD schema (pcd::base64) is decoded by formats/pcd.ts; the adapter
 * that picks between these three lives in `from-ifcx-attributes.ts`.
 */

import type { DecodedPointChunk, PointCloudBBox } from '../types.js';

export interface PointsArrayAttribute {
  positions: number[][];
  colors?: number[][];
}

export interface PointsBase64Attribute {
  positions: string;
  colors?: string;
}

export function decodePointsArray(attr: PointsArrayAttribute): DecodedPointChunk {
  if (!Array.isArray(attr.positions)) {
    throw new Error('points::array: positions must be an array of [x,y,z] triples');
  }
  const count = attr.positions.length;
  if (count === 0) {
    // Empty arrays would produce ±Infinity bbox, which poisons fit-to-view
    // and section-plane logic downstream. Fail fast with a clear error
    // instead of returning a sentinel "empty cloud".
    throw new Error('points::array: positions must contain at least one point');
  }
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const p = attr.positions[i];
    if (!Array.isArray(p) || p.length < 3) {
      throw new Error(`points::array: positions[${i}] must be a [x,y,z] triple`);
    }
    positions[i * 3] = p[0];
    positions[i * 3 + 1] = p[1];
    positions[i * 3 + 2] = p[2];
  }
  let colors: Float32Array | undefined;
  if (attr.colors) {
    if (!Array.isArray(attr.colors)) {
      throw new Error('points::array: colors must be an array of [r,g,b] triples');
    }
    if (attr.colors.length !== count) {
      throw new Error(`points::array: colors length (${attr.colors.length}) ` +
        `does not match positions length (${count})`);
    }
    colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const c = attr.colors[i];
      if (!Array.isArray(c) || c.length < 3) {
        throw new Error(`points::array: colors[${i}] must be an [r,g,b] triple`);
      }
      colors[i * 3] = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }
  }
  return {
    positions,
    colors,
    pointCount: count,
    bbox: computeBBox(positions),
  };
}

export function decodePointsBase64(attr: PointsBase64Attribute): DecodedPointChunk {
  if (typeof attr.positions !== 'string' || attr.positions.length === 0) {
    throw new Error('points::base64: positions must be a non-empty base64 string');
  }
  const positions = base64ToFloat32(attr.positions);
  if (positions.length % 3 !== 0) {
    throw new Error(`points::base64: positions buffer length (${positions.length}) ` +
      `is not a multiple of 3 floats`);
  }
  const count = positions.length / 3;
  if (count === 0) {
    throw new Error('points::base64: positions must contain at least one point');
  }
  let colors: Float32Array | undefined;
  // Use !== undefined so an empty string isn't silently treated as "no
  // colors" — that would let a malformed payload downgrade to an
  // uncolored cloud without surfacing the bug.
  if (attr.colors !== undefined && attr.colors !== null) {
    if (typeof attr.colors !== 'string' || attr.colors.length === 0) {
      throw new Error('points::base64: colors must be a non-empty base64 string when provided');
    }
    colors = base64ToFloat32(attr.colors);
    if (colors.length !== positions.length) {
      throw new Error(`points::base64: colors length (${colors.length}) ` +
        `does not match positions length (${positions.length})`);
    }
  }
  return {
    positions,
    colors,
    pointCount: count,
    bbox: computeBBox(positions),
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function base64ToFloat32(b64: string): Float32Array {
  const bytes = base64ToBytes(b64);
  // The slice() guarantees we own a fresh ArrayBuffer aligned for Float32.
  // Without it, the source buffer's offset can be misaligned (Float32Array
  // requires byteOffset % 4 === 0).
  const aligned = bytes.byteOffset % 4 === 0
    ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    : new Float32Array(bytes.slice().buffer);
  // Copy out — callers must own the buffer once we return.
  return new Float32Array(aligned);
}

function base64ToBytes(b64: string): Uint8Array {
  // Works in both browser (atob) and Node 18+ (Buffer fallback).
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buf: any = (globalThis as unknown as { Buffer?: { from: (s: string, e: string) => Uint8Array } }).Buffer;
  if (buf && typeof buf.from === 'function') {
    return new Uint8Array(buf.from(b64, 'base64'));
  }
  throw new Error('No base64 decoder available in this environment');
}

function computeBBox(positions: Float32Array): PointCloudBBox {
  // Mirrors the e57.ts guards: empty / non-finite input must produce
  // finite zero-bbox rather than ±Infinity, which would poison camera
  // fit-to-view and section-plane math.
  if (positions.length < 3) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    any = true;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!any) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
