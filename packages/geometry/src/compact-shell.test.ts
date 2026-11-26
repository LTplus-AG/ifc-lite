/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'vitest';
import { COMPACT_RECORD_BYTES, COMPACT_TABLE_STRIDE, compactBounds, type CompactPayload } from './compact-geometry.js';
import { adoptCompactMeshes, boundsView, decodeCompactMesh, processBatchBounds } from './compact-shell.js';
import * as compactMesh from './compact-mesh.js';
import { compactHydrationStats, copyMeshShell, loadCompactGeometry, materializeCompactMesh, meshTriangleCount, meshVertexCount } from './compact-mesh.js';
import { CoordinateHandler } from './coordinate-handler.js';
import type { MeshData } from './types.js';

// A compact payload built in JavaScript in the layout the wasm encoder writes (level 10, one window
// per mesh starting 1 m below its minimum corner). Not an encoder: no welding, levels or refusals.
interface TestCompactMesh {
  expressId: number;
  /** World corners (origin already added), xyz per vertex. */
  vertices: readonly (readonly [number, number, number])[];
  /** One normal per vertex. */
  normals: readonly (readonly [number, number, number])[];
  triangles: readonly (readonly [number, number, number])[];
}

function octEncode(n: readonly [number, number, number]): number {
  const l1 = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) || 1;
  let ox = n[0] / l1, oy = n[1] / l1;
  if (n[2] < 0) {
    const tx = (1 - Math.abs(oy)) * (ox >= 0 ? 1 : -1), ty = (1 - Math.abs(ox)) * (oy >= 0 ? 1 : -1);
    ox = tx; oy = ty;
  }
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round((v * 0.5 + 0.5) * 255)));
  return (byte(ox) << 8) | byte(oy);
}

function buildTestCompactPayload(meshes: readonly TestCompactMesh[], level = 10): CompactPayload {
  const scale = 2 ** level;
  const vertexTotal = meshes.reduce((n, m) => n + m.vertices.length, 0);
  const indexTotal = meshes.reduce((n, m) => n + m.triangles.length * 3, 0);
  const payload: CompactPayload = {
    records: new Uint8Array(vertexTotal * COMPACT_RECORD_BYTES),
    indices: new Uint16Array(indexTotal),
    table: new Uint32Array(meshes.length * COMPACT_TABLE_STRIDE),
    windows: new Float64Array(meshes.length * 3),
    bounds: new Float64Array(meshes.length * 6),
    cells: new Int32Array(meshes.length * 3),
  };
  const view = new DataView(payload.records.buffer);
  let vertexAt = 0, indexAt = 0;
  meshes.forEach((mesh, row) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const v of mesh.vertices) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[a]); max[a] = Math.max(max[a], v[a]); }
    const window = min.map((v) => Math.floor(v * scale) - scale);
    payload.table.set([row, vertexAt, mesh.vertices.length, indexAt, mesh.triangles.length * 3, level, mesh.vertices.length], row * COMPACT_TABLE_STRIDE);
    payload.windows.set(window, row * 3);
    payload.bounds.set([...min, ...max], row * 6);
    payload.cells.set(window.map((w) => Math.floor(w / (32 * 1024))), row * 3);
    mesh.vertices.forEach((v, i) => {
      const at = (vertexAt + i) * COMPACT_RECORD_BYTES;
      for (let a = 0; a < 3; a++) view.setUint16(at + a * 2, Math.round(v[a] * scale) - window[a], true);
      view.setUint16(at + 6, octEncode(mesh.normals[i]), true);
      view.setUint32(at + 8, mesh.expressId & 0x00ffffff, true);
    });
    for (const t of mesh.triangles) { payload.indices.set(t, indexAt); indexAt += 3; }
    vertexAt += mesh.vertices.length;
  });
  return payload;
}

/** An axis box `[x, y, z]` .. `[x + s, y + s, z + s]` with welded corners and outward corner normals. */
function testCompactBox(expressId: number, at: readonly [number, number, number], s: number): TestCompactMesh {
  const vertices: [number, number, number][] = [], normals: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const bit = [i & 1, (i >> 1) & 1, (i >> 2) & 1];
    vertices.push([at[0] + bit[0] * s, at[1] + bit[1] * s, at[2] + bit[2] * s]);
    normals.push([bit[0] * 2 - 1, bit[1] * 2 - 1, bit[2] * 2 - 1]);
  }
  // Two triangles per face, wound outward.
  const triangles: [number, number, number][] = [
    [0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4],
    [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5],
  ];
  return { expressId, vertices, normals, triangles };
}

/** What a worker posts for `boxes`: shells with empty arrays and wire refs into one payload. */
function workerBatch(boxes: readonly TestCompactMesh[], origin?: [number, number, number]): { meshes: MeshData[]; payload: CompactPayload } {
  const payload = buildTestCompactPayload(boxes);
  const meshes = boxes.map((box, row) => ({
    expressId: box.expressId, positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0),
    color: [0.5, 0.5, 0.5, 1] as [number, number, number, number], ...(origin ? { origin } : {}),
    compact: { batch: 0, row },
  })) as unknown as MeshData[];
  return { meshes, payload };
}

function adopted(boxes: readonly TestCompactMesh[], origin?: [number, number, number]): MeshData[] {
  const { meshes, payload } = workerBatch(boxes, origin);
  adoptCompactMeshes(meshes, [payload]);
  return meshes;
}

/** Meshes and triangles decoded since the current test began (the counter is realm-wide). */
let before = { meshes: 0, triangles: 0 };
const decoded = () => ({ meshes: compactHydrationStats().meshes - before.meshes, triangles: compactHydrationStats().triangles - before.triangles });
beforeEach(() => { before = compactHydrationStats(); });

describe('decodeCompactMesh', () => {
  it('returns flat triangles on the lattice, relative to the origin, with outward face normals', () => {
    const box = testCompactBox(7, [10.25, -3.5, 2], 1.5);
    const origin: [number, number, number] = [10, -4, 2];
    const decoded = decodeCompactMesh({ payload: buildTestCompactPayload([box]), row: 0 }, origin);
    expect(decoded.indices.length).toBe(36);
    expect(decoded.positions.length).toBe(36 * 3);
    const centre = [11, -2.75, 2.75];
    for (let t = 0; t < 36; t += 3) {
      const corner = (k: number, a: number) => decoded.positions[(t + k) * 3 + a] + origin[a];
      // Every corner is a box corner, exactly (the test box lies on the lattice).
      for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) expect([box.vertices[0][a], box.vertices[7][a]]).toContain(corner(k, a));
      // One unit normal per triangle, pointing away from the box centre.
      const n = [decoded.normals[t * 3], decoded.normals[t * 3 + 1], decoded.normals[t * 3 + 2]];
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 6);
      const away = [0, 1, 2].reduce((sum, a) => sum + n[a] * ((corner(0, a) + corner(1, a) + corner(2, a)) / 3 - centre[a]), 0);
      expect(away).toBeGreaterThan(0);
      for (let k = 1; k < 3; k++) for (let a = 0; a < 3; a++) expect(decoded.normals[(t + k) * 3 + a]).toBe(n[a]);
    }
  });

  it('orients a face by its stored normals, not by its winding', () => {
    const box = testCompactBox(1, [0, 0, 0], 1);
    const inward = { ...box, triangles: box.triangles.map(([a, b, c]) => [a, c, b] as [number, number, number]) };
    const decoded = decodeCompactMesh({ payload: buildTestCompactPayload([inward]), row: 0 });
    // First triangle is the z = 0 face: its normal still points to -z although the winding now says +z.
    expect(Array.from(decoded.normals.subarray(0, 3), (v) => v + 0)).toEqual([0, 0, -1]); // + 0: no negative zero
  });
});

describe('compact shells', () => {
  it('decode on first read, once, and count it', () => {
    const [mesh] = adopted([testCompactBox(3, [0, 0, 0], 2)]);
    expect(decoded()).toEqual({ meshes: 0, triangles: 0 });
    expect(meshTriangleCount(mesh)).toBe(12);
    expect(meshVertexCount(mesh)).toBe(8);
    expect(decoded().meshes).toBe(0);
    const positions = mesh.positions;
    expect(positions.length).toBe(36 * 3);
    expect(mesh.positions).toBe(positions);
    expect(mesh.indices.length).toBe(36);
    expect(decoded()).toEqual({ meshes: 1, triangles: 12 });
  });

  it('leave a mesh the worker did not tag alone', () => {
    const { meshes, payload } = workerBatch([testCompactBox(3, [0, 0, 0], 2)]);
    const plain: MeshData = { expressId: 9, positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array(3), color: [1, 1, 1, 1] };
    adoptCompactMeshes([plain, ...meshes], [payload]);
    expect(plain.compact).toBeUndefined();
    expect(plain.positions.length).toBe(9);
    expect(meshes[0].compact).toMatchObject({ payload, row: 0 });
  });

  it('spread into a plain f32 mesh without the row', () => {
    const [mesh] = adopted([testCompactBox(3, [0, 0, 0], 2)]);
    const copy = { ...mesh, color: [1, 0, 0, 1] as [number, number, number, number] };
    expect(copy.compact).toBeUndefined();
    expect(copy.positions).toBeInstanceOf(Float32Array);
    expect(copy.positions.length).toBe(36 * 3);
    expect(Object.getOwnPropertyDescriptor(copy, 'positions')?.get).toBeUndefined();
    expect(mesh.compact).toBeDefined();
  });

  it('copy as shells without decoding, and share one decode', () => {
    const [mesh] = adopted([testCompactBox(3, [1, 2, 3], 2)], [1, 2, 3]);
    const copy = copyMeshShell(mesh);
    copy.origin = [101, 2, 3]; // a placed copy: same local positions, moved frame
    expect(copy.compact).toBe(mesh.compact);
    expect(decoded().meshes).toBe(0);
    expect(copy.positions).toBe(mesh.positions);
    expect(decoded().meshes).toBe(1);
    expect(Math.min(...copy.positions)).toBe(0);
  });

  it('stop being compact when their geometry is replaced', () => {
    const [mesh] = adopted([testCompactBox(3, [0, 0, 0], 2)]);
    mesh.indices = new Uint32Array(0);
    expect(mesh.compact).toBeUndefined();
    // The row no longer speaks for the mesh: it draws what it now holds.
    expect(meshTriangleCount(mesh)).toBe(0);
    expect(mesh.positions.length).toBe(36 * 3);
    expect(Object.getOwnPropertyDescriptor(mesh, 'positions')?.get).toBeUndefined();
  });

  it('carry no source-corner provenance: a decode cannot be mapped back to source corners', () => {
    const { meshes, payload } = workerBatch([testCompactBox(3, [0, 0, 0], 2)]);
    meshes[0].appearanceSource = { kind: 'canonical-item', indices: meshes[0].indices, sourceIndices: meshes[0].indices };
    adoptCompactMeshes(meshes, [payload]);
    expect(meshes[0].appearanceSource).toBeUndefined();
  });

  it('materialize into an ordinary mesh', () => {
    const [mesh] = adopted([testCompactBox(3, [0, 0, 0], 2)]);
    materializeCompactMesh(mesh);
    expect(mesh.compact).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(mesh, 'indices')?.value).toBeInstanceOf(Uint32Array);
    expect(meshTriangleCount(mesh)).toBe(12);
    materializeCompactMesh(mesh); // no-op
    expect(decoded().meshes).toBe(1);
  });
});

describe('bounds without decoding', () => {
  it('stands a shell in by its box', () => {
    const meshes = adopted([testCompactBox(3, [100.5, 0, -7], 2)]);
    const plain: MeshData = { expressId: 9, positions: new Float32Array([0, 0, 0, 1, 1, 1, 2, 0, 0]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] };
    const view = boundsView([plain, ...meshes]);
    expect(view[0]).toBe(plain);
    const o = view[1].origin!;
    const corners = [0, 3].map((v) => [0, 1, 2].map((a) => o[a] + view[1].positions[v + a]));
    expect(corners).toEqual([[100.5, 0, -7], [102.5, 2, -5]]);
    expect(Array.from(compactBounds(meshes[0].compact!))).toEqual([100.5, 0, -7, 102.5, 2, -5]);
    expect(boundsView([plain])[0]).toBe(plain);
    expect(decoded().meshes).toBe(0);
  });

  it('feeds the coordinate handler the same bounds a decoded mesh gives', () => {
    const handler = new CoordinateHandler();
    const meshes = adopted([testCompactBox(3, [4, 5, 6], 2), testCompactBox(4, [-3, 0, 0], 1)]);
    processBatchBounds(handler, meshes);
    const info = handler.getCurrentCoordinateInfo()!;
    expect(info.originalBounds.min).toEqual({ x: -3, y: 0, z: 0 });
    expect(info.originalBounds.max).toEqual({ x: 6, y: 7, z: 8 });
    expect(decoded().meshes).toBe(0);
    expect(meshes.every((mesh) => mesh.compact)).toBe(true);
  });

  it('turns shells into f32 meshes where the handler recentres positions itself', () => {
    const real = new CoordinateHandler();
    const shift = { x: 499_999, y: 0, z: 299_999 };
    const meshes = adopted([testCompactBox(3, [500_000, 20, 300_000], 2)]);
    processBatchBounds({
      processMeshesIncremental: () => undefined,
      getOriginShift: () => shift,
      shiftPositions: (positions, by) => real.shiftPositions(positions, by),
    }, meshes);
    expect(meshes[0].compact).toBeUndefined();
    // The decoded positions moved with the rest of the model: they sit around the new origin.
    expect(Math.min(...meshes[0].positions)).toBe(1);
    expect(Math.max(...meshes[0].positions)).toBe(22);
  });
});

it('the test payload has the wire layout the decoder reads', () => {
  const payload = buildTestCompactPayload([testCompactBox(5, [0, 0, 0], 1)]);
  expect(payload.records.length).toBe(8 * COMPACT_RECORD_BYTES);
  expect(Array.from(payload.table)).toEqual([0, 0, 8, 0, 36, 10, 8]);
  expect(payload.table.length).toBe(COMPACT_TABLE_STRIDE);
});

describe('the eager part before the decoder is loaded', () => {
  it('reports unloaded, passes batches without payloads through, and refuses one with payloads', async () => {
    // A fresh module instance: the one imported above may already be loaded by another test.
    const { vi } = await import('vitest');
    vi.resetModules();
    const fresh: typeof compactMesh = await import('./compact-mesh.js');
    expect(fresh.compactGeometryLoaded()).toBe(false);
    const plain: MeshData = { expressId: 1, positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array(3), color: [1, 1, 1, 1] };
    fresh.adoptCompactMeshes([plain], undefined);
    const seen: MeshData[][] = [];
    fresh.processBatchBounds({ processMeshesIncremental: (batch) => { seen.push(batch); }, getOriginShift: () => ({ x: 0, y: 0, z: 0 }), shiftPositions: () => undefined }, [plain]);
    expect(seen).toEqual([[plain]]);
    const { payload } = workerBatch([testCompactBox(1, [0, 0, 0], 1)]);
    expect(() => fresh.adoptCompactMeshes([plain], [payload])).toThrow(/loadCompactGeometry/);
    await fresh.loadCompactGeometry();
    expect(fresh.compactGeometryLoaded()).toBe(true);
    expect(fresh.materializeCompactMeshes([plain])).toEqual([plain]);
  });

  it('adopts through the loaded decoder', async () => {
    await loadCompactGeometry();
    const { meshes, payload } = workerBatch([testCompactBox(4, [0, 0, 0], 1)]);
    compactMesh.adoptCompactMeshes(meshes, [payload]);
    expect(meshes[0].compact).toMatchObject({ payload, row: 0 });
    expect(meshTriangleCount(meshes[0])).toBe(12);
  });
});
