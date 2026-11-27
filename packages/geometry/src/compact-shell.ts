/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact meshes on the main thread: the part that reads their records.
 *
 * A compact mesh arrives as a `MeshData` whose triangles exist only as GPU
 * records (`compact-geometry.ts`). The renderer draws those records directly.
 * Everything else in the codebase reads `positions` / `normals` / `indices`,
 * so `adoptCompactMeshes` makes those three properties decode from the records
 * the first time one is read: a consumer that never asks costs nothing, and one
 * that does gets ordinary f32 arrays instead of an empty mesh.
 *
 * The decode is not the source mesh: positions sit on the record's lattice (at
 * most half a step from the source on each axis, 0.49 mm at level 10), and the
 * triangles come back flat-shaded, three vertices each with the face normal on
 * the side the stored normals witness, which is what the renderer draws.
 *
 * `compact` is a non-enumerable property, so a spread copy (`{ ...mesh }`) is a
 * plain f32 mesh: it reads the three arrays and leaves the row behind.
 *
 * This module is loaded on demand (`loadCompactGeometry` in compact-mesh.ts),
 * so a host that never asks for compact records never fetches it. What stays
 * in the eager bundle is compact-mesh.ts.
 */

import { compactBounds, compactRow, compactStep, COMPACT_RECORD_BYTES, type CompactPayload, type CompactRef, type CompactWireRef } from './compact-geometry.js';
import { GEOMETRY_KEYS, materializeCompactMesh, noteCompactHydration } from './compact-mesh.js';
import type { MeshData } from './types.js';

interface DecodedGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** What every copy of one shell shares: the row, the frame its positions are relative to, and the decode. */
interface ShellCell {
  ref: CompactRef;
  origin: readonly [number, number, number];
  decoded?: DecodedGeometry;
}

/** The renderer's `octDecode` (quantize.ts): two bytes to a unit normal. */
function octDecode(bx: number, by: number, out: Float64Array): void {
  const ox = (bx / 255) * 2 - 1, oy = (by / 255) * 2 - 1;
  let nx = ox, ny = oy;
  const nz = 1 - Math.abs(ox) - Math.abs(oy);
  if (nz < 0) {
    nx = (1 - Math.abs(oy)) * (ox >= 0 ? 1 : -1);
    ny = (1 - Math.abs(ox)) * (oy >= 0 ? 1 : -1);
  }
  out[0] = nx; out[1] = ny; out[2] = nz;
}

/**
 * A compact row as flat-shaded f32 geometry, positions relative to `origin`
 * (`world = origin + position`, as every `MeshData`).
 */
export function decodeCompactMesh(ref: CompactRef, origin: readonly [number, number, number] = [0, 0, 0]): DecodedGeometry {
  const { vertexStart, indexStart, indexCount, level } = compactRow(ref);
  const { records, indices: source, windows } = ref.payload;
  const view = new DataView(records.buffer, records.byteOffset + vertexStart * COMPACT_RECORD_BYTES);
  const step = compactStep(level);
  const w = ref.row * 3;
  const positions = new Float32Array(indexCount * 3);
  const normals = new Float32Array(indexCount * 3);
  const indices = new Uint32Array(indexCount);
  const corner = new Float64Array(9), stored = new Float64Array(3);
  for (let t = 0; t < indexCount; t += 3) {
    let sx = 0, sy = 0, sz = 0;
    for (let k = 0; k < 3; k++) {
      const at = source[indexStart + t + k] * COMPACT_RECORD_BYTES;
      for (let axis = 0; axis < 3; axis++) {
        corner[k * 3 + axis] = (windows[w + axis] + view.getUint16(at + axis * 2, true)) * step;
      }
      const oct = view.getUint16(at + 6, true);
      octDecode(oct >> 8, oct & 0xff, stored);
      sx += stored[0]; sy += stored[1]; sz += stored[2];
    }
    const ux = corner[3] - corner[0], uy = corner[4] - corner[1], uz = corner[5] - corner[2];
    const vx = corner[6] - corner[0], vy = corner[7] - corner[1], vz = corner[8] - corner[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    let length = Math.hypot(nx, ny, nz);
    if (length === 0) {
      // Collinear on the lattice: no face plane, so the stored normals are all there is.
      nx = sx; ny = sy; nz = sz;
      length = Math.hypot(nx, ny, nz) || 1;
    } else if (nx * sx + ny * sy + nz * sz < 0) {
      // IFC winding is not reliably outward; the stored normals say which side the face shows.
      length = -length;
    }
    for (let k = 0; k < 3; k++) {
      const o = (t + k) * 3;
      positions[o] = corner[k * 3] - origin[0];
      positions[o + 1] = corner[k * 3 + 1] - origin[1];
      positions[o + 2] = corner[k * 3 + 2] - origin[2];
      normals[o] = nx / length; normals[o + 1] = ny / length; normals[o + 2] = nz / length;
      indices[t + k] = t + k;
    }
  }
  return { positions, normals, indices };
}

function hydrate(cell: ShellCell): DecodedGeometry {
  if (!cell.decoded) {
    cell.decoded = decodeCompactMesh(cell.ref, cell.origin);
    noteCompactHydration(cell.decoded.indices.length / 3);
  }
  return cell.decoded;
}

function installShell(mesh: MeshData, ref: CompactRef): void {
  const o = mesh.origin;
  const cell: ShellCell = { ref, origin: o ? [o[0], o[1], o[2]] : [0, 0, 0] };
  ref.origin = cell.origin;
  for (const key of GEOMETRY_KEYS) {
    Object.defineProperty(mesh, key, {
      enumerable: true,
      configurable: true,
      get: () => hydrate(cell)[key],
      // A write replaces the geometry: the object stops being a compact mesh, so its row no longer
      // speaks for it (counts, bounds, pages). The other two arrays keep their decoded values.
      set(this: MeshData, value: Float32Array | Uint32Array) {
        materializeCompactMesh(this);
        Object.defineProperty(this, key, { value, enumerable: true, configurable: true, writable: true });
      },
    });
  }
  Object.defineProperty(mesh, 'compact', { value: ref, enumerable: false, configurable: true, writable: true });
  // The worker stamped the source-corner provenance over the arrays the encoder emptied. A decode is
  // re-welded and cannot be mapped back to source corners, so the mesh carries none.
  delete mesh.appearanceSource;
}

/**
 * Main side: turn each mesh a worker tagged with a wire ref into a compact
 * shell over its payload (in place). Meshes without a tag are left alone.
 */
export function adoptCompactMeshes(meshes: readonly MeshData[], payloads: readonly CompactPayload[] | undefined): void {
  if (!payloads || payloads.length === 0) return;
  for (const mesh of meshes) {
    const wire = (mesh as { compact?: unknown }).compact as CompactWireRef | undefined;
    if (!wire || typeof wire.batch !== 'number') continue;
    delete mesh.compact;
    const payload = payloads[wire.batch];
    if (payload) installShell(mesh, { payload, row: wire.row });
  }
}

/**
 * The batch as a bounds pass may read it: every compact shell replaced by a
 * two-vertex stand-in spanning its box (`origin` = box minimum in f64, so the
 * corners are exact), every other mesh itself. Returns `meshes` when it holds
 * no shell.
 */
export function boundsView(meshes: MeshData[]): MeshData[] {
  if (!meshes.some((mesh) => mesh.compact)) return meshes;
  return meshes.map((mesh) => {
    if (!mesh.compact) return mesh;
    const b = compactBounds(mesh.compact);
    return {
      expressId: mesh.expressId,
      positions: new Float32Array([0, 0, 0, b[3] - b[0], b[4] - b[1], b[5] - b[2]]),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      color: mesh.color,
      origin: [b[0], b[1], b[2]],
    };
  });
}

/** The part of `CoordinateHandler` a streamed batch goes through. */
interface BatchBoundsHandler {
  processMeshesIncremental(batch: MeshData[]): void;
  getOriginShift(): { x: number; y: number; z: number };
  shiftPositions(positions: Float32Array, shift: { x: number; y: number; z: number }): void;
}

/**
 * `handler.processMeshesIncremental(meshes)` without decoding a compact shell
 * for its bounds. Where the handler recentres positions itself (a model the
 * wasm did not put in an RTC frame), records cannot move with them: those
 * shells become ordinary f32 meshes and are shifted like the rest.
 */
export function processBatchBounds(handler: BatchBoundsHandler, meshes: MeshData[]): void {
  const view = boundsView(meshes);
  handler.processMeshesIncremental(view);
  if (view === meshes) return;
  const shift = handler.getOriginShift();
  if (shift.x === 0 && shift.y === 0 && shift.z === 0) return;
  for (const mesh of meshes) {
    if (!mesh.compact) continue;
    materializeCompactMesh(mesh);
    handler.shiftPositions(mesh.positions, shift);
  }
}
