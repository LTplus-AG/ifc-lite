/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';

import {
  ModelBoundsTracker,
  type ModelBoundsBox,
  type ModelBoundsSources,
  type TupleBounds,
} from './model-bounds-tracker.js';

/**
 * First-ever coverage for `ModelBoundsTracker` (issue #2425 / PR #2430).
 * `modelBounds` was private on a WebGPU-bound `Renderer` before this
 * extraction, so none of the behaviours below were previously testable.
 *
 * These are CHARACTERIZATION tests: they pin what the tracker does today,
 * including quirks the PR description calls out deliberately (aliasing,
 * the placeholder-cube discard). They do not assert an "improved" contract.
 */

function makeSources(overrides: Partial<ModelBoundsSources> = {}): ModelBoundsSources {
  return {
    meshBounds: () => null,
    pointCloudBounds: () => null,
    ...overrides,
  };
}

function makeMesh(overrides: Partial<MeshData> = {}): MeshData {
  return {
    expressId: 1,
    positions: new Float32Array([]),
    normals: new Float32Array([]),
    indices: new Uint32Array([]),
    color: [0, 0, 0, 1],
    ...overrides,
  } as unknown as MeshData;
}

const box = (min: [number, number, number], max: [number, number, number]): ModelBoundsBox => ({
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] },
});

const tuple = (min: [number, number, number], max: [number, number, number]): TupleBounds => ({
  min,
  max,
});

describe('ModelBoundsTracker construction', () => {
  it('starts with a null bounds', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    assert.strictEqual(tracker.get(), null);
  });
});

describe('ModelBoundsTracker.set', () => {
  it('replaces the tracked value outright, by reference', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    const b = box([0, 0, 0], [1, 1, 1]);
    tracker.set(b);
    assert.strictEqual(tracker.get(), b);
  });
});

describe('ModelBoundsTracker.recompute — null semantics', () => {
  it('clears to null when neither mesh nor point-cloud bounds exist (mutation target: `if (!meshBounds && !pcBounds)`)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    // Seed a non-null value first so a no-op implementation wouldn't pass by accident.
    tracker.set(box([0, 0, 0], [1, 1, 1]));
    tracker.recompute();
    assert.strictEqual(tracker.get(), null);
  });

  it('recompute from meshBounds alone adopts the mesh box BY REFERENCE (mutation target: `this.bounds = meshBounds ?? {...}`)', () => {
    const mb = box([1, 2, 3], [4, 5, 6]);
    const tracker = new ModelBoundsTracker(makeSources({ meshBounds: () => mb }));
    tracker.recompute();
    assert.strictEqual(tracker.get(), mb, 'tracker must alias the mesh-bounds object, not copy it');
  });

  it('recompute from point-cloud bounds alone converts the tuple into the object shape (mutation target: the pcBounds!.min[0]/[1]/[2] fallback branch)', () => {
    const pc = tuple([1, 2, 3], [4, 5, 6]);
    const tracker = new ModelBoundsTracker(makeSources({ pointCloudBounds: () => pc }));
    tracker.recompute();
    assert.deepStrictEqual(tracker.get(), box([1, 2, 3], [4, 5, 6]));
  });

  it('recompute with both sources present folds point-cloud bounds onto the mesh baseline, still by reference to the mesh box (mutation target: the `if (meshBounds && pcBounds) this.expandForPointClouds()` call)', () => {
    const mb = box([0, 0, 0], [1, 1, 1]);
    const pc = tuple([-5, -5, -5], [0.5, 0.5, 0.5]);
    const tracker = new ModelBoundsTracker(
      makeSources({ meshBounds: () => mb, pointCloudBounds: () => pc }),
    );
    tracker.recompute();
    assert.strictEqual(tracker.get(), mb, 'baseline object identity is preserved (in-place expand)');
    assert.deepStrictEqual(tracker.get(), box([-5, -5, -5], [1, 1, 1]));
  });
});

describe('ModelBoundsTracker.expandForPointClouds', () => {
  it('is a no-op when there is no point-cloud data (mutation target: `if (!pcBounds) return;`)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    const b = box([0, 0, 0], [1, 1, 1]);
    tracker.set(b);
    tracker.expandForPointClouds();
    assert.strictEqual(tracker.get(), b);
    assert.deepStrictEqual(tracker.get(), box([0, 0, 0], [1, 1, 1]));
  });

  it('seeds from null (first write) by converting the tuple (mutation target: `if (!this.bounds) { ... return; }`)', () => {
    const pc = tuple([2, 3, 4], [5, 6, 7]);
    const tracker = new ModelBoundsTracker(makeSources({ pointCloudBounds: () => pc }));
    assert.strictEqual(tracker.get(), null);
    tracker.expandForPointClouds();
    assert.deepStrictEqual(tracker.get(), box([2, 3, 4], [5, 6, 7]));
  });

  it('grows an existing box IN PLACE — same object identity before and after (mutation target: any of the six Math.min/Math.max assignments)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    const b = box([0, 0, 0], [1, 1, 1]);
    tracker.set(b);
    const before = tracker.get();

    const tracker2 = new ModelBoundsTracker(
      makeSources({ pointCloudBounds: () => tuple([-2, 0.5, 0.5], [0.5, 2, 0.5]) }),
    );
    tracker2.set(b);
    tracker2.expandForPointClouds();
    const after = tracker2.get();

    assert.strictEqual(after, before, 'expansion mutates the same object the camera aliases (#2430 constraint)');
    assert.deepStrictEqual(after, box([-2, 0, 0], [1, 2, 1]));
  });

  it('is monotonic: expanding by a box already fully contained does not shrink the bounds', () => {
    const tracker = new ModelBoundsTracker(
      makeSources({ pointCloudBounds: () => tuple([2, 2, 2], [3, 3, 3]) }),
    );
    const b = box([0, 0, 0], [10, 10, 10]);
    tracker.set(b);
    tracker.expandForPointClouds();
    assert.deepStrictEqual(tracker.get(), box([0, 0, 0], [10, 10, 10]));
  });
});

describe('ModelBoundsTracker.updateFromMeshes', () => {
  it('seeds from +/-Infinity on first write, so a mesh with no finite vertex leaves it at Infinity (mutation target: the seeded Infinity initializer)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    tracker.updateFromMeshes([makeMesh({ positions: new Float32Array([]) })]);
    const b = tracker.get();
    assert.ok(b, 'bounds object is created even with no vertices to fold');
    assert.strictEqual(b!.min.x, Infinity);
    assert.strictEqual(b!.max.x, -Infinity);
  });

  it('folds per-mesh origin into world-space positions (mutation target: `const ox = o ? o[0] : 0` / the position+origin sum)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    tracker.updateFromMeshes([
      makeMesh({
        positions: new Float32Array([0, 0, 0, 1, 1, 1]),
        origin: [10, 20, 30],
      }),
    ]);
    assert.deepStrictEqual(tracker.get(), box([10, 20, 30], [11, 21, 31]));
  });

  it('skips non-finite vertices (mutation target: the `Number.isFinite(x) && ...` guard)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    tracker.updateFromMeshes([
      makeMesh({ positions: new Float32Array([1, 1, 1, NaN, 5, 5, Infinity, 2, 2]) }),
    ]);
    assert.deepStrictEqual(tracker.get(), box([1, 1, 1], [1, 1, 1]));
  });

  it('accumulates across calls IN PLACE (same identity) and never shrinks (mutation target: reusing `this.bounds` instead of reseeding on every call)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    tracker.updateFromMeshes([makeMesh({ positions: new Float32Array([0, 0, 0, 1, 1, 1]) })]);
    const first = tracker.get();
    tracker.updateFromMeshes([makeMesh({ positions: new Float32Array([-3, -3, -3, 0.5, 0.5, 0.5]) })]);
    const second = tracker.get();
    assert.strictEqual(second, first, 'accumulation mutates the same object across loadGeometry/addMeshes calls');
    assert.deepStrictEqual(second, box([-3, -3, -3], [1, 1, 1]));
  });
});

describe('ModelBoundsTracker.expandWithFlatVertices', () => {
  it('is a no-op on an empty buffer (mutation target: `if (positions.length === 0) return;`)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    tracker.expandWithFlatVertices(new Float32Array([]), 3);
    assert.strictEqual(tracker.get(), null);
  });

  it('seeds from Infinity on first write and pads a degenerate (point) extent by 0.5m per axis (mutation target: the 1e-3 degenerate check and the 0.5 padding constants)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    tracker.expandWithFlatVertices(new Float32Array([5, 5, 5]), 3);
    // A single point has zero extent on every axis, so all three get padded.
    assert.deepStrictEqual(tracker.get(), box([4.5, 4.5, 4.5], [5.5, 5.5, 5.5]));
  });

  it('pads only the degenerate axis, leaving a non-degenerate axis untouched (mutation target: per-axis padding applied uniformly instead of per-axis)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    // A flat line along x: y and z are single-valued (degenerate), x spans 10.
    tracker.expandWithFlatVertices(new Float32Array([0, 1, 1, 10, 1, 1]), 3);
    assert.deepStrictEqual(tracker.get(), box([0, 0.5, 0.5], [10, 1.5, 1.5]));
  });

  it('respects stride, skipping interleaved attributes (mutation target: the `i += stride` loop step)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    // stride 4: one padding float after each xyz triple, which must be skipped.
    const data = new Float32Array([0, 0, 0, 999, 2, 2, 2, 999]);
    tracker.expandWithFlatVertices(data, 4);
    assert.deepStrictEqual(tracker.get(), box([0, 0, 0], [2, 2, 2]));
  });

  it('expands an existing non-placeholder box in place, without resetting it (mutation target: the isPlaceholderCube guard misfiring on real bounds)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    const existing = box([0, 0, 0], [1, 1, 1]);
    tracker.set(existing);
    tracker.expandWithFlatVertices(new Float32Array([5, 5, 5]), 3);
    assert.strictEqual(tracker.get(), existing, 'in-place expansion keeps identity for non-placeholder bounds');
    assert.deepStrictEqual(tracker.get(), box([0, 0, 0], [5, 5, 5]));
  });

  it('detects the exact [-100,100] placeholder cube and DISCARDS it rather than merging (mutation target: `isPlaceholderCube` / the `|| isPlaceholderCube(this.bounds)` branch)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    tracker.set(box([-100, -100, -100], [100, 100, 100]));
    tracker.expandWithFlatVertices(new Float32Array([1, 2, 3]), 3);
    // If the placeholder were merged instead of discarded, the box would still
    // span [-100,100] on every axis. Pin that it does not: it becomes the
    // small annotation-only box (with degenerate-axis padding), replacing the
    // placeholder outright.
    const b = tracker.get()!;
    assert.notStrictEqual(b.min.x, -100);
    assert.notStrictEqual(b.max.x, 100);
    assert.deepStrictEqual(b, box([0.5, 1.5, 2.5], [1.5, 2.5, 3.5]));
  });

  it('does NOT treat a near-miss box (off by epsilon) as the placeholder, since the detection is an exact === match (mutation target: `===` vs a tolerant comparison)', () => {
    const tracker = new ModelBoundsTracker(makeSources());
    const nearMiss = box([-100, -100, -100], [100, 100, 99.999]);
    tracker.set(nearMiss);
    tracker.expandWithFlatVertices(new Float32Array([1000, 1000, 1000]), 3);
    assert.strictEqual(tracker.get(), nearMiss, 'a near-miss box is treated as real data and expanded, not discarded');
    assert.deepStrictEqual(tracker.get(), box([-100, -100, -100], [1000, 1000, 1000]));
  });
});
