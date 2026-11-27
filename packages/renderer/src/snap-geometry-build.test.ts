/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The resumable snap geometry build (#11504): same answer as the one-call build, in many bounded steps. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { CandidateBuild, candidatesFromCache } from './snap-corner-candidates.js';
import { ChunkedSort } from './snap-chunked-sort.js';
import { RunMergeBuild } from './snap-edge-merge.js';
import { GeometryCacheBuild } from './snap-geometry-build.js';
import { buildGeometryCache } from './snap-geometry-cache.js';
import { SnapDetector } from './snap-detector.js';

/** `n` separate unit-ish boxes (24 vertices, 12 triangles each), optionally jittered below the weld tolerance. */
function boxes(n: number, jitter = 0): MeshData {
  const pos: number[] = [], idx: number[] = [];
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const base = pos.length / 3;
    for (const p of [a, b, c, d]) pos.push(p[0] + rnd() * jitter, p[1] + rnd() * jitter, p[2] + rnd() * jitter);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let b = 0; b < n; b++) {
    const x = (b % 30) * 0.3, y = Math.floor(b / 30) * 0.3, h = 0.1;
    const P = (i: number, j: number, k: number) => [x + i * h, y + j * h, k * h];
    quad(P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0)); quad(P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1));
    quad(P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)); quad(P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1));
    quad(P(0, 0, 0), P(0, 1, 0), P(0, 1, 1), P(0, 0, 1)); quad(P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1));
  }
  return {
    expressId: 5, positions: new Float32Array(pos), normals: new Float32Array(pos.length), indices: new Uint32Array(idx),
    color: [1, 1, 1, 1], origin: [1000.5, 20, 3],
  } as unknown as MeshData;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v));

it('#11753 emits each welded box corner once across incident feature edges and split face vertices', () => {
  for (const jitter of [0, 1e-6]) {
    const mesh = boxes(1, jitter);
    const cache = buildGeometryCache(mesh);
    assert.equal(cache.vertices.length, 8);
    const { corners } = candidatesFromCache(mesh.expressId, cache);
    assert.equal(corners.length, 8 * 3);
    const actual = Array.from({ length: 8 }, (_, i) => Array.from(corners.subarray(i * 3, i * 3 + 3)).join(','));
    assert.deepEqual(new Set(actual), new Set(cache.vertices.map(p => [p.x, p.y, p.z].join(','))));
  }
});

it('#11753 budgets junction reads and final packing for a single reconstructed edge', () => {
  const count = 4096, budget = 32;
  let reads = 0;
  const point = (x: number) => ({ x, y: 0, z: 0 });
  const junctions = Array.from({ length: count }, (_, i) => ({
    get point() { reads++; return point(i + 1); }, valence: 3, t: (i + 1) / (count + 1),
  }));
  const edge = { v0: point(0), v1: point(count + 1), index: 0, length: count + 1,
    v0Valence: 3, v1Valence: 3, junctions };
  const build = new CandidateBuild(1, { vertices: [], edges: [edge] });
  let packingSteps = 0;
  while (!build.done) {
    const before = reads;
    build.step(budget);
    assert.ok(reads - before <= budget, `one step read ${reads - before} junctions`);
    if (before === count) packingSteps++;
  }
  assert.equal(reads, count);
  assert.ok(packingSteps >= count / budget, 'final packing spans slices');
  const result = build.result();
  assert.equal(result.corners, build.result().corners);
  const expected = [0, count + 1, ...Array.from({ length: count }, (_, i) => i + 1)];
  assert.deepEqual([...result.corners], expected.flatMap(x => [x, 0, 0]));
  assert.deepEqual([...result.edges], [0, 0, 0, count + 1, 0, 0]);
});

it('#11753 bounds comparisons at a crowded weld and traversal of one long run', t => {
  const sqrt = Math.sqrt;
  let operations = 0;
  t.mock.method(Math, 'sqrt', (x: number) => { operations++; return sqrt(x); });
  for (const chain of [false, true]) {
    const count = chain ? 12000 : 300;
    const points = [{ x: 0, y: 0, z: 0 }];
    const segments = [];
    for (let i = 1; i <= count; i++) {
      points.push(chain ? {x:i,y:0,z:0} : {x:1,y:i/count,z:0});
      segments.push({a:chain ? i-1 : 0,b:i});
    }
    const build = new RunMergeBuild(segments,points,1e-8);
    while (!build.done) {
      operations = 0;
      build.step();
      assert.ok(operations <= 4096, `one merge step did ${operations} square roots`);
    }
    assert.equal(build.result().length, chain ? 1 : count);
    if (chain) assert.equal(build.result()[0].length,count);
    else assert.ok(build.result().every(edge => edge.v0Valence === count));
  }
});

describe('ChunkedSort', () => {
  for (const n of [0, 1, 2, 2047, 2048, 2049, 5000, 20001]) {
    it(`sorts ${n} indices like Array.prototype.sort, ties in input order`, () => {
      // Few distinct keys so most comparisons tie: stability decides the order.
      const key = Array.from({ length: n }, (_, i) => (i * 7919) % 37);
      const cmp = (a: number, b: number) => key[a] - key[b];
      const idx = Int32Array.from({ length: n }, (_, i) => i);
      const sort = new ChunkedSort(Int32Array.from(idx), cmp);
      let steps = 0;
      while (!sort.step()) steps++;
      assert.deepStrictEqual([...sort.result()], [...idx].sort(cmp));
      if (n > 4096) assert.ok(steps > 3, `${n} indices sorted in ${steps + 1} steps`);
    });
  }
});

describe('GeometryCacheBuild', () => {
  for (const [name, mesh] of [['plain boxes', boxes(400)], ['boxes jittered inside the weld tolerance', boxes(300, 2e-5)]] as const) {
    it(`${name}: stepwise result equals buildGeometryCache, over many steps`, () => {
      const build = new GeometryCacheBuild(mesh);
      let steps = 1;
      while (!build.step()) steps++;
      assert.ok(steps > 20, `${steps} steps`);
      assert.deepStrictEqual(json(build.result()), json(buildGeometryCache(mesh)));
    });
  }

  it('#11753 returns exactly the twelve axis-aligned edges of one box', () => {
    const cache = buildGeometryCache(boxes(1));
    const h = Math.fround(0.1);
    const vertex = (bits: number) => [1000.5 + (bits & 1 ? h : 0), 20 + (bits & 2 ? h : 0), 3 + (bits & 4 ? h : 0)].join(',');
    const pair = (a: string, b: string) => [a, b].sort().join('|');
    const expected: string[] = [];
    for (let i = 0; i < 8; i++) for (const axis of [1, 2, 4]) {
      if (!(i & axis)) expected.push(pair(vertex(i), vertex(i | axis)));
    }
    assert.deepEqual(cache.edges.map(({ v0, v1 }) => pair([v0.x,v0.y,v0.z].join(','), [v1.x,v1.y,v1.z].join(','))).sort(), expected.sort());
  });

  it('an empty mesh and a mesh without indices finish at once', () => {
    const empty = { ...boxes(1), positions: new Float32Array(0) } as MeshData;
    assert.strictEqual(new GeometryCacheBuild(empty).done, true);
    const noIndex = { ...boxes(1), indices: undefined } as unknown as MeshData;
    const b = new GeometryCacheBuild(noIndex);
    while (!b.step()) { /* weld steps */ }
    assert.deepStrictEqual(b.result().edges, []);
    assert.ok(b.result().vertices.length > 0);
  });
});

describe('SnapDetector.startGeometryCache', () => {
  it('stores the finished cache so a pick sees the very object the idle build made', () => {
    const detector = new SnapDetector();
    const mesh = boxes(40);
    const build = detector.startGeometryCache(mesh);
    while (!build.step()) { /* idle steps */ }
    const cache = build.result();
    assert.strictEqual(detector.getGeometryCache(mesh), cache);
    assert.strictEqual(detector.startGeometryCache(mesh).done, true, 'a cached piece needs no build');
  });

  it('keeps the cache a pick built while the idle build was in flight', () => {
    const detector = new SnapDetector();
    const mesh = boxes(40);
    const build = detector.startGeometryCache(mesh);
    build.step();
    const fromPick = detector.getGeometryCache(mesh);
    assert.ok(build.done && build.step(), 'the pick completed the cache while idle work was suspended');
    assert.strictEqual(build.result(), fromPick);
  });
});
