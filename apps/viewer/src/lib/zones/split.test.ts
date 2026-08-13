/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer half of the zone geometry split (#2508 item 2).
 *
 * The cutting itself is the Rust kernel's and is tested there (hand-computable
 * fractions, rotated zones, degenerate input) plus across the real wasm
 * boundary in `scripts/test-wasm-contract.mjs`. What is testable HERE, and is
 * where this half can go wrong quietly, is the frame arithmetic: the renderer
 * stores positions relative to a per-mesh origin and zones are absolute, so an
 * unfolded origin produces a split that is correct and in the wrong place.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenZones,
  foldPiecesToWorld,
  flatNormals,
  splitElementByZones,
  ZONE_STRIDE,
  type SplitMeshByZonesFn,
  type ZoneSplitHandle,
  type ZoneSplitPieceHandle,
} from './split.js';
import type { Zone } from './types.js';

const ZONE: Zone = {
  id: 'z-a',
  name: 'Takt A',
  center: [1, 2, 3],
  size: [4, 5, 6],
  rotationY: 0.5,
};

/** A single triangle, stored relative to `origin`. */
function piece(origin: [number, number, number], offset = 0) {
  return {
    positions: new Float32Array([offset, 0, 0, 1 + offset, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    origin,
  };
}

/** A fake binding whose output is fully controlled, so the frame arithmetic
 *  around it is what the assertions see. */
function fakeSplit(
  pieces: Array<{ zoneIndex: number; positions: number[]; volume: number }>,
  options: { wholeVolume?: number; sumErrorRel?: number; onFree?: () => void } = {},
): { fn: SplitMeshByZonesFn; calls: Array<{ positions: Float64Array; zones: Float64Array }> } {
  const calls: Array<{ positions: Float64Array; zones: Float64Array }> = [];
  const fn: SplitMeshByZonesFn = (positions, _indices, zones) => {
    calls.push({ positions, zones });
    const handle: ZoneSplitHandle = {
      pieceCount: pieces.length,
      wholeVolume: options.wholeVolume ?? 1,
      sumErrorRel: options.sumErrorRel ?? 0,
      piece(index: number): ZoneSplitPieceHandle | undefined {
        const p = pieces[index];
        if (!p) return undefined;
        return {
          zoneIndex: p.zoneIndex,
          positions: Float64Array.from(p.positions),
          indices: Uint32Array.from(p.positions.map((_, i) => i / 3).filter((v) => Number.isInteger(v))),
          volume: p.volume,
          free: () => { options.onFree?.(); },
        };
      },
      free: () => { options.onFree?.(); },
    };
    return handle;
  };
  return { fn, calls };
}

describe('flattenZones', () => {
  it('writes seven numbers per zone, sizes as full extents', () => {
    const flat = flattenZones([ZONE]);
    assert.equal(flat.zones.length, ZONE_STRIDE);
    assert.deepEqual([...flat.zones], [1, 2, 3, 4, 5, 6, 0.5]);
    assert.deepEqual([...flat.footprintCounts], [0], 'a box must not claim footprint points');
  });

  it('keeps zone order, so a piece\'s zoneIndex means what the caller thinks', () => {
    const second: Zone = { ...ZONE, id: 'z-b', center: [9, 9, 9] };
    const flat = flattenZones([ZONE, second]);
    assert.equal(flat.zones[ZONE_STRIDE], 9);
  });

  it('carries a prism\'s footprint alongside, index-aligned by its point count', () => {
    // The counts array is what lets the binding find each zone's points
    // without an offset table, so a box between two prisms must contribute a
    // zero rather than nothing.
    const prism: Zone = { ...ZONE, id: 'z-p', footprint: [[0, 0], [1, 0], [1, 1]] };
    const flat = flattenZones([ZONE, prism, ZONE]);
    assert.deepEqual([...flat.footprintCounts], [0, 3, 0]);
    assert.deepEqual([...flat.footprints], [0, 0, 1, 0, 1, 1]);
  });
});

describe('foldPiecesToWorld', () => {
  it('folds each piece\'s own origin in, not the first piece\'s', () => {
    // Submeshes of one element can carry different origins. Folding them all
    // with the first origin would move every later submesh.
    const world = foldPiecesToWorld([piece([10, 0, 0]), piece([0, 20, 0])]);
    assert.equal(world.positions[0], 10, 'first piece not at its own origin');
    assert.equal(world.positions[10], 20, 'second piece folded with the wrong origin');
  });

  it('offsets indices so concatenated submeshes still index their own vertices', () => {
    const world = foldPiecesToWorld([piece([0, 0, 0]), piece([0, 0, 0], 5)]);
    assert.deepEqual([...world.indices], [0, 1, 2, 3, 4, 5]);
  });

  it('reports the origin it will take back out', () => {
    assert.deepEqual(foldPiecesToWorld([piece([7, 8, 9])]).origin, [7, 8, 9]);
  });
});

describe('splitElementByZones', () => {
  it('hands the binding ABSOLUTE coordinates and takes the origin back out', () => {
    // The whole point of the fold/unfold pair: zones are absolute, the
    // renderer is origin-relative, and the output has to go back to the
    // renderer's frame or a far-from-origin model collapses in f32.
    const { fn, calls } = fakeSplit([{ zoneIndex: 0, positions: [1000, 0, 0, 1001, 0, 0, 1000, 1, 0], volume: 1 }]);
    const result = splitElementByZones(fn, [piece([1000, 0, 0])], [ZONE]);

    assert.ok(result);
    assert.equal(calls[0].positions[0], 1000, 'the binding was given relative coordinates');
    assert.equal(result.pieces[0].positions[0], 0, 'the origin was not taken back out');
    assert.deepEqual(result.pieces[0].origin, [1000, 0, 0]);
  });

  it('maps the remainder\'s -1 to null rather than to zone zero', () => {
    const { fn } = fakeSplit([{ zoneIndex: -1, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], volume: 2 }]);
    const result = splitElementByZones(fn, [piece([0, 0, 0])], [ZONE]);
    assert.equal(result?.pieces[0].zoneIndex, null);
  });

  it('refuses the whole split when the pieces do not sum to the whole', () => {
    // A per-section model whose sections do not add up to the building is
    // worse than none, because it looks finished. The expected cause is zones
    // that overlap each other.
    const { fn } = fakeSplit(
      [{ zoneIndex: 0, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], volume: 5 }],
      { sumErrorRel: 0.5 },
    );
    assert.equal(splitElementByZones(fn, [piece([0, 0, 0])], [ZONE]), null);
  });

  it('frees the wasm handle even when the split is refused', () => {
    let freed = 0;
    const { fn } = fakeSplit(
      [{ zoneIndex: 0, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], volume: 5 }],
      { sumErrorRel: 0.5, onFree: () => { freed++; } },
    );
    splitElementByZones(fn, [piece([0, 0, 0])], [ZONE]);
    assert.ok(freed > 0, 'a refused split leaked its handle');
  });

  it('does not call the binding at all when there is nothing to split', () => {
    const { fn, calls } = fakeSplit([]);
    assert.equal(splitElementByZones(fn, [], [ZONE]), null);
    assert.equal(splitElementByZones(fn, [piece([0, 0, 0])], []), null);
    assert.equal(calls.length, 0);
  });
});

describe('flatNormals', () => {
  it('gives every vertex of a triangle its own face normal, unit length', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = flatNormals(positions, new Uint32Array([0, 1, 2]));
    assert.deepEqual([...normals], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it('falls back rather than emitting NaN for a degenerate triangle', () => {
    // A zero-area triangle has no normal. NaN would propagate into the GLB and
    // render as a black hole rather than as nothing.
    const positions = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const normals = flatNormals(positions, new Uint32Array([0, 1, 2]));
    assert.ok([...normals].every(Number.isFinite));
  });
});
