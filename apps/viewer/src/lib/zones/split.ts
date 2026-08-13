/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turning one element into one mesh per zone (issue #2508 item 2), around the
 * Rust `splitMeshByZones` binding.
 *
 * #2515 answers "how much of this wall is in Takt A" with a number and produces
 * no geometry. This produces the geometry, so a per-section model can be
 * exported rather than described. It is a separate, explicit action for the
 * reason the apportionment is: clipping is memory-bandwidth bound, so the only
 * lever is doing less of it.
 *
 * The binding is INJECTED rather than imported here, exactly as
 * `meshOutlineProvider` does for `meshOutline2d`: the wasm runtime is
 * gitignored and absent in the node test runner, and a module that reached for
 * it at import time could not be tested at all. Everything in this file except
 * the one call is therefore ordinary arithmetic with a test around it.
 *
 * ## The frame, which is the part that goes wrong quietly
 *
 * The renderer stores each element's positions RELATIVE to a per-mesh origin
 * (`MeshData.origin`), so building-scale coordinates stay f32-precise. Zones are
 * authored in absolute world coordinates. So the split folds the origin in on
 * the way down (f64, absolute) and takes it back out on the way up, which keeps
 * the output exactly as f32-precise as the input was. Skipping the unfold would
 * hand the GPU absolute metre coordinates in f32 and collapse a 5 km-away model
 * onto a visible grid.
 */

import type { Zone } from './types.js';
import type { ElementMeshPiece } from './apportionment.js';

/** One solid of a split, as the wasm handle exposes it. */
export interface ZoneSplitPieceHandle {
  readonly zoneIndex: number;
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
  readonly volume: number;
  free?(): void;
}

/** The wasm result handle. Freed by {@link splitElementByZones}. */
export interface ZoneSplitHandle {
  readonly pieceCount: number;
  readonly wholeVolume: number;
  readonly sumErrorRel: number;
  piece(index: number): ZoneSplitPieceHandle | undefined;
  free(): void;
}

/** The `splitMeshByZones` free function as exported by `@ifc-lite/wasm`. */
export type SplitMeshByZonesFn = (
  positions: Float64Array,
  indices: Uint32Array,
  zones: Float64Array,
) => ZoneSplitHandle;

/** Seven numbers per zone, the order the binding documents. */
export const ZONE_STRIDE = 7;

/** Zones flattened for the binding: `[cx, cy, cz, sx, sy, sz, rotationY]` each,
 *  sizes as FULL extents, matching `Zone.size` rather than half-extents. */
export function flattenZones(zones: readonly Zone[]): Float64Array {
  const out = new Float64Array(zones.length * ZONE_STRIDE);
  zones.forEach((zone, i) => {
    const b = i * ZONE_STRIDE;
    out[b] = zone.center[0];
    out[b + 1] = zone.center[1];
    out[b + 2] = zone.center[2];
    out[b + 3] = zone.size[0];
    out[b + 4] = zone.size[1];
    out[b + 5] = zone.size[2];
    out[b + 6] = zone.rotationY;
  });
  return out;
}

/** One element's renderer pieces as a single absolute-world f64 mesh.
 *
 *  Concatenating first is not an optimisation: the pieces of one element are
 *  submeshes of ONE solid (a wall and its own reveals), and splitting each
 *  separately would ask the kernel to close a surface that is only closed when
 *  they are taken together. */
export function foldPiecesToWorld(pieces: readonly ElementMeshPiece[]): {
  positions: Float64Array;
  indices: Uint32Array;
  /** The origin taken out again on the way back, so the output keeps the
   *  input's f32 precision. */
  origin: [number, number, number];
} {
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of pieces) {
    vertexCount += p.positions.length / 3;
    indexCount += p.indices.length;
  }
  const positions = new Float64Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const origin: [number, number, number] = [
    pieces[0]?.origin?.[0] ?? 0,
    pieces[0]?.origin?.[1] ?? 0,
    pieces[0]?.origin?.[2] ?? 0,
  ];

  let vertexBase = 0;
  let indexBase = 0;
  for (const p of pieces) {
    const ox = p.origin?.[0] ?? 0;
    const oy = p.origin?.[1] ?? 0;
    const oz = p.origin?.[2] ?? 0;
    const count = p.positions.length / 3;
    for (let i = 0; i < count; i++) {
      const s = (vertexBase + i) * 3;
      const t = i * 3;
      positions[s] = p.positions[t] + ox;
      positions[s + 1] = p.positions[t + 1] + oy;
      positions[s + 2] = p.positions[t + 2] + oz;
    }
    for (let i = 0; i < p.indices.length; i++) {
      indices[indexBase + i] = p.indices[i] + vertexBase;
    }
    vertexBase += count;
    indexBase += p.indices.length;
  }
  return { positions, indices, origin };
}

/** A piece of an element, expressed the way the renderer and the GLB exporter
 *  already consume geometry. */
export interface ZoneMeshPiece {
  /** Index into the zone array that was split against, or `null` for the part
   *  of the element in no zone. */
  zoneIndex: number | null;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  origin: [number, number, number];
  /** Enclosed volume of this piece, cubic metres. */
  volumeM3: number;
}

export interface ElementSplit {
  pieces: ZoneMeshPiece[];
  wholeVolumeM3: number;
  /** How far the pieces are from summing to the whole, relative. */
  sumErrorRel: number;
}

/**
 * Above this relative error, a split is not published.
 *
 * The pieces summing to the whole is the invariant #2508 puts above every other
 * for this feature, and unlike the apportionment path the failure here is not
 * subtle: the expected cause is zones that overlap each other, which
 * double-counts entire fractions of an element. 1e-4 matches the apportionment
 * tolerance, which was set from a measured f32-crack worst case of 3.4e-6 over
 * 241 real straddlers.
 */
export const SPLIT_SUM_TOLERANCE_REL = 1e-4;

/**
 * Split one element's geometry by `zones`.
 *
 * Returns `null` when the element has no geometry, or when the pieces do not
 * sum to the whole within {@link SPLIT_SUM_TOLERANCE_REL}. Refusing the whole
 * split rather than publishing part of it is deliberate: a per-section model
 * whose sections do not add up to the building is worse than no per-section
 * model, because it looks finished.
 */
export function splitElementByZones(
  split: SplitMeshByZonesFn,
  pieces: readonly ElementMeshPiece[],
  zones: readonly Zone[],
  tolerance = SPLIT_SUM_TOLERANCE_REL,
): ElementSplit | null {
  if (pieces.length === 0 || zones.length === 0) return null;
  const { positions, indices, origin } = foldPiecesToWorld(pieces);
  if (indices.length === 0) return null;

  const handle = split(positions, indices, flattenZones(zones));
  try {
    if (handle.sumErrorRel > tolerance) return null;
    const out: ZoneMeshPiece[] = [];
    for (let i = 0; i < handle.pieceCount; i++) {
      const piece = handle.piece(i);
      if (!piece) continue;
      try {
        out.push(toMeshPiece(piece, origin));
      } finally {
        piece.free?.();
      }
    }
    return { pieces: out, wholeVolumeM3: handle.wholeVolume, sumErrorRel: handle.sumErrorRel };
  } finally {
    handle.free();
  }
}

/** Absolute f64 kernel output back into the renderer's origin-relative f32
 *  form, with flat per-face normals (the kernel emits an unwelded triangle
 *  soup, so a shared-vertex normal would be meaningless). */
function toMeshPiece(piece: ZoneSplitPieceHandle, origin: [number, number, number]): ZoneMeshPiece {
  const src = piece.positions;
  const positions = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    positions[i] = src[i] - origin[0];
    positions[i + 1] = src[i + 1] - origin[1];
    positions[i + 2] = src[i + 2] - origin[2];
  }
  const indices = Uint32Array.from(piece.indices);
  return {
    zoneIndex: piece.zoneIndex < 0 ? null : piece.zoneIndex,
    positions,
    normals: flatNormals(positions, indices),
    indices,
    origin,
    volumeM3: piece.volume,
  };
}

/** Per-face normals, written to all three vertices of each triangle. */
export function flatNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = 0;
      ny = 0;
      nz = 1;
    }
    for (const v of [a, b, c]) {
      normals[v] = nx;
      normals[v + 1] = ny;
      normals[v + 2] = nz;
    }
  }
  return normals;
}
