/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `traceScanOutline` across the real wasm boundary (#6871): the handle's
 * field surface, ring orientation and nesting as JS reads them, the plane
 * frame mapping to world coordinates, the diagnostics object, and the
 * refusals for malformed options. The tracing itself is pinned by the Rust
 * tests in `rust/geometry/src/scan_outline/`; this checks what crosses.
 */

import assert from 'node:assert/strict';
import { traceScanOutline } from '../../packages/wasm/pkg/ifc-lite.js';

/** Seeded mulberry32, so the slab is the same on every run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plane points on the faces of a 6 m × 4 m room with 0.2 m walls: the inner
 * faces at x = 0, 6 and y = 0, 4, the outer at -0.2, 6.2 and -0.2, 4.2.
 */
function roomSlab(perMetre = 300, sigma = 0.003) {
  const rand = rng(6871);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-300))) * Math.cos(2 * Math.PI * rand());
  const faces = [
    [0, 0, 6, 0], [6, 0, 6, 4], [6, 4, 0, 4], [0, 4, 0, 0],
    [-0.2, -0.2, 6.2, -0.2], [6.2, -0.2, 6.2, 4.2], [6.2, 4.2, -0.2, 4.2], [-0.2, 4.2, -0.2, -0.2],
  ];
  const out = [];
  for (const [x0, y0, x1, y1] of faces) {
    const n = Math.round(Math.hypot(x1 - x0, y1 - y0) * perMetre);
    for (let i = 0; i < n; i++) {
      const t = rand();
      out.push(x0 + t * (x1 - x0) + sigma * gauss(), y0 + t * (y1 - y0) + sigma * gauss());
    }
  }
  return Float32Array.from(out);
}

function rings(outline) {
  const coords = outline.coords();
  const lengths = outline.ringLengths();
  const out = [];
  let at = 0;
  for (const n of lengths) {
    const ring = [];
    for (let k = 0; k < n; k++) ring.push([coords[(at + k) * 2], coords[(at + k) * 2 + 1]]);
    out.push(ring);
    at += n;
  }
  assert.equal(at * 2, coords.length, 'ringLengths account for every coordinate');
  return out;
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Distance from (x, y) to the nearest of the room's wall faces. */
function faceDistance([x, y]) {
  const lines = [[0, 'x'], [6, 'x'], [-0.2, 'x'], [6.2, 'x'], [0, 'y'], [4, 'y'], [-0.2, 'y'], [4.2, 'y']];
  return Math.min(...lines.map(([v, axis]) => Math.abs((axis === 'x' ? x : y) - v)));
}

export function runScanOutlineContracts({ test }) {
  console.log('\n📋 traceScanOutline (#6871)');

  test('a room slab gives an outer ring and a hole, wound and nested as documented', () => {
    const outline = traceScanOutline(roomSlab());
    try {
      assert.equal(outline.ringCount, 2);
      assert.equal(outline.shapeCount, 1);
      assert.deepEqual([...outline.shapeOffsets()], [0]);
      assert.deepEqual([...outline.ringParents()], [-1, 0]);
      const [outer, hole] = rings(outline);
      assert.equal(outer.length, 4);
      assert.equal(hole.length, 4);
      assert.ok(signedArea(outer) > 0, 'outer ring is counter-clockwise');
      assert.ok(signedArea(hole) < 0, 'hole is clockwise');
      assert.ok(Math.abs(Math.abs(signedArea(hole)) - 24) < 0.15, `room area ${signedArea(hole)}`);
      for (const p of [...outer, ...hole]) {
        // Corners sit on two faces, so the nearest face is within noise.
        assert.ok(faceDistance(p) < 0.015, `vertex ${p} is ${faceDistance(p)} m off the walls`);
      }
      assert.equal(outline.worldCoords(), undefined, 'no frame, no world coordinates');
    } finally {
      outline.free();
    }
  });

  test('worldCoords maps every plane vertex through the frame', () => {
    const frame = { origin: [10, 1.2, -5], uAxis: [1, 0, 0], vAxis: [0, 0, -1] };
    const outline = traceScanOutline(roomSlab(), undefined, frame);
    try {
      const plane = outline.coords();
      const world = outline.worldCoords();
      assert.equal(world.length, (plane.length / 2) * 3);
      for (let i = 0; i < plane.length / 2; i++) {
        const [u, v] = [plane[i * 2], plane[i * 2 + 1]];
        assert.deepEqual([world[i * 3], world[i * 3 + 1], world[i * 3 + 2]], [10 + u, 1.2, -5 - v]);
      }
    } finally {
      outline.free();
    }
  });

  test('diagnostics come back as a camelCase object with the documented fields', () => {
    const outline = traceScanOutline(roomSlab(), { maxGap: 2 });
    try {
      const d = outline.diagnostics();
      for (const key of [
        'inputPoints', 'usedPoints', 'nonFinitePoints', 'outlierPoints', 'cellSize', 'gridWidth', 'gridHeight',
        'countThreshold', 'occupiedCells', 'solidCells', 'componentsDropped', 'holesFilled', 'ringCount',
        'outerRingCount', 'holeRingCount', 'vertexCount', 'simplifyReinsertions', 'snappedEdges', 'squaredEdges',
        'revertedMoves', 'dominantAngleDeg', 'coordinateSpacingMetres',
      ]) {
        assert.equal(typeof d[key], 'number', key);
      }
      assert.equal(d.maxGapClamped, true, 'a 2 m gap is clamped to the 0.5 m limit');
      assert.equal(d.cellCapHit, false);
      assert.equal(d.inputPoints, roomSlab().length / 2);
    } finally {
      outline.free();
    }
  });

  test('a small cell budget coarsens the grid and reports it', () => {
    const outline = traceScanOutline(roomSlab(), { cellSize: 0.01, maxCells: 20000 });
    try {
      const d = outline.diagnostics();
      assert.equal(d.cellCapHit, true);
      assert.ok(d.gridWidth * d.gridHeight <= 20000);
      assert.ok(d.cellSize > 0.01);
    } finally {
      outline.free();
    }
  });

  test('empty and non-finite input give an empty outline, not a throw', () => {
    for (const input of [new Float32Array(), Float32Array.from([NaN, 1, Infinity, 2])]) {
      const outline = traceScanOutline(input);
      try {
        assert.equal(outline.ringCount, 0);
        assert.equal(outline.coords().length, 0);
      } finally {
        outline.free();
      }
    }
  });

  test('malformed options and frames throw instead of tracing with defaults', () => {
    const slab = roomSlab(50);
    assert.throws(() => traceScanOutline(slab, { maxgap: 0.3 }), /invalid options/);
    assert.throws(() => traceScanOutline(slab, { maxCells: 1 }), /maxCells/);
    assert.throws(() => traceScanOutline(slab, { cellSize: -1 }), /cellSize/);
    assert.throws(() => traceScanOutline(slab, { maxGap: 'wide' }), /invalid options/);
    assert.throws(
      () => traceScanOutline(slab, undefined, { origin: [0, NaN, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0] }),
      /plane frame/,
    );
    assert.throws(() => traceScanOutline(slab, undefined, { origin: [0, 0, 0], uAxis: [1, 0, 0] }), /plane frame/);
  });

  // Review of #6883: the old conversion turned NaN into null (= silently the
  // default) and refused `undefined` although the .d.ts marks it optional.
  test('non-finite options throw and undefined options mean the default', () => {
    const slab = roomSlab(50);
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => traceScanOutline(slab, { maxGap: bad }), /maxGap must be a finite number/);
    }
    assert.throws(() => traceScanOutline(slab, { cellSize: NaN }), /cellSize must be a finite number/);
    const withUndefined = traceScanOutline(slab, { maxGap: undefined, cellSize: undefined });
    const plain = traceScanOutline(slab);
    try {
      assert.deepEqual([...withUndefined.coords()], [...plain.coords()]);
    } finally {
      withUndefined.free();
      plain.free();
    }
  });

  test('a cell budget below the padding floor is refused, never a trap', () => {
    const few = Float32Array.from([0, 0, 0.01, 0, 0, 0.01, 50, 50]);
    for (let maxCells = 64; maxCells <= 80; maxCells++) {
      assert.throws(() => traceScanOutline(few, { maxCells }), /maxCells must be in 81\.\./);
    }
    const outline = traceScanOutline(few, { maxCells: 81 });
    outline.free();
    assert.throws(() => traceScanOutline(few, { maxVertexMoveCells: 1e4 }), /maxVertexMoveCells/);
    assert.throws(() => traceScanOutline(few, { snapDistanceCells: 600 }), /snapDistanceCells/);
  });

  test('far-from-origin input reports degraded coordinate precision', () => {
    const near = traceScanOutline(roomSlab());
    const far = traceScanOutline(roomSlab().map((v, i) => v + (i % 2 === 0 ? 2_600_000 : 1_200_000)));
    try {
      assert.equal(near.diagnostics().coordinatePrecisionDegraded, false);
      assert.equal(far.diagnostics().coordinatePrecisionDegraded, true);
      assert.ok(far.diagnostics().coordinateSpacingMetres >= 0.25);
    } finally {
      near.free();
      far.free();
    }
  });
}
