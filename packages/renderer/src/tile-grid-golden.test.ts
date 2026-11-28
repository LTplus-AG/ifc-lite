/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tile grid contract of docs/architecture/tiled-federation.md, renderer side.
 *
 * `tests/fixtures/tiled-federation/tile-grid.json` is the one fixture the
 * server tiler (Rust) and the renderer (TypeScript) both have to reproduce. It
 * was generated from this package, so these tests fail when the renderer's
 * cell or clustering rule moves without the fixture, which is the moment the
 * two sides would start to disagree about which tile a mesh is in.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chunkCellKey, DEFAULT_CHUNK_CELL_SIZE } from './chunk-grid.js';
import { PROXY_WORKER_SOURCE } from './draw-stream-proxy-worker.js';

interface CellCase { name: string; originBits: string[] | null; vertexBits: string[] | null; rendererKey: string; cell: number[] | null }
interface NodeCase { cell: number[]; levels: { level: number; coords: number[] }[] }
interface ClusterVertex { positionBits: string[]; id: number; slot: number; cluster: number[] }
interface ClusterExpect { slot: number; triangleCount: number; cornerIds: number[]; cornerPositionBits: string[] }
interface Fixture {
  leafCellMetres: number;
  cellCoordinateRange: { min: number; max: number };
  cells: CellCase[];
  nodes: NodeCase[];
  clustering: { clusterSizeBits: string; vertices: ClusterVertex[]; indices: number[]; expect: ClusterExpect[] };
}

const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/tiled-federation/tile-grid.json', import.meta.url), 'utf8')) as Fixture;

function f64(bits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${bits}`));
  return view.getFloat64(0);
}

function f32(bits: string): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, Number.parseInt(bits, 16));
  return view.getFloat32(0);
}

function f32Bits(value: number): string {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return view.getUint32(0).toString(16).padStart(8, '0');
}

/** The tile cell of a renderer chunk key: null (the stray tile) when it is not three integers inside the range. */
function tileCell(key: string, range: { min: number; max: number }): number[] | null {
  if (key === 'nan') return null;
  const parts = key.split(',').map(Number);
  return parts.length === 3 && parts.every((p) => Number.isInteger(p) && p >= range.min && p <= range.max) ? parts : null;
}

describe('tile grid golden fixture', () => {
  it('uses the chunk grid cell size', () => {
    assert.equal(fixture.leafCellMetres, DEFAULT_CHUNK_CELL_SIZE);
  });

  it('assigns every anchor to the fixture cell', () => {
    assert.ok(fixture.cells.length >= 10, 'fixture lost its cell cases');
    for (const c of fixture.cells) {
      const origin = c.originBits ? (c.originBits.map(f64) as [number, number, number]) : undefined;
      const positions = c.vertexBits ? new Float32Array(c.vertexBits.map(f32)) : new Float32Array(0);
      const key = chunkCellKey({ origin, positions }, fixture.leafCellMetres);
      assert.equal(key, c.rendererKey, `${c.name}: chunk key`);
      assert.deepEqual(tileCell(key, fixture.cellCoordinateRange), c.cell, `${c.name}: tile cell`);
    }
  });

  it('derives coarser node coordinates by flooring, as HlodTree does with >> 1 per level', () => {
    for (const n of fixture.nodes) {
      for (const { level, coords } of n.levels) {
        let c = n.cell;
        for (let i = 0; i < level; i++) c = c.map((v) => v >> 1);
        assert.deepEqual(c, coords, `cell ${n.cell.join(',')} at level ${level}`);
      }
    }
  });

  it('clusters a triangle soup as the proxy worker does', () => {
    const { vertices, indices, expect, clusterSizeBits } = fixture.clustering;
    let pieces: { slot: number; positions: Float32Array; ids: Uint32Array }[] = [];
    const scope: { onmessage?: (event: { data: unknown }) => void; postMessage(message: { pieces: typeof pieces }): void } = {
      postMessage(message) { pieces = message.pieces; },
    };
    new Function('self', PROXY_WORKER_SOURCE)(scope);
    assert.ok(scope.onmessage, 'worker source installed no handler');
    scope.onmessage({ data: {
      job: 1,
      positions: new Float32Array(vertices.flatMap((v) => v.positionBits.map(f32))),
      ids: new Uint32Array(vertices.map((v) => v.id)),
      colors: new Uint16Array(vertices.map((v) => v.slot)),
      indices: new Uint32Array(indices),
      cell: f64(clusterSizeBits),
    } });
    assert.equal(pieces.length, expect.length, 'colour slots with surviving triangles');
    for (const want of expect) {
      const got = pieces.find((p) => p.slot === want.slot);
      assert.ok(got, `slot ${want.slot} missing`);
      assert.equal(got.ids.length / 3, want.triangleCount, `slot ${want.slot}: triangles`);
      assert.deepEqual([...got.ids], want.cornerIds, `slot ${want.slot}: corner ids`);
      assert.deepEqual([...got.positions].map(f32Bits), want.cornerPositionBits, `slot ${want.slot}: cluster centroids`);
    }
  });

  it('states each soup vertex cluster as floor(position / clusterSize)', () => {
    const size = f64(fixture.clustering.clusterSizeBits);
    const inverse = 1 / size;
    for (const v of fixture.clustering.vertices) {
      const cluster = v.positionBits.map((bits) => Math.min(65535, Math.max(-65536, Math.floor(f32(bits) * inverse))));
      assert.deepEqual(cluster, v.cluster, `vertex of element ${v.id}`);
    }
  });
});
