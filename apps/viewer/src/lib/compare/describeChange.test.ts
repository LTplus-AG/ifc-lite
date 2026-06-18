/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { summarizeGeometryChange, type Aabb } from './describeChange.js';

const box = (min: [number, number, number], max: [number, number, number]): Aabb => ({ min, max });

describe('summarizeGeometryChange (#1197)', () => {
  it('reports no move and no reshape for an identical bounding box', () => {
    // The wall that "moved 1.09 m" had an identical bbox between revisions — a
    // re-tessellation dragged the old *vertex-weighted* centroid, not the box.
    const b = box([0, 0, 0], [3, 0.3, 2.7]);
    const summary = summarizeGeometryChange(b, { min: [...b.min] as [number, number, number], max: [...b.max] as [number, number, number] });
    assert.ok(summary);
    assert.strictEqual(summary!.movedDistance, 0, 'identical box must not read as moved');
    assert.strictEqual(summary!.reshaped, false);
  });

  it('reports a real translation as a move (box centre shifts)', () => {
    const a = box([0, 0, 0], [3, 0.3, 2.7]);
    const b = box([1, 0, 0], [4, 0.3, 2.7]); // +1 in x
    const summary = summarizeGeometryChange(a, b)!;
    assert.ok(Math.abs(summary.movedDistance - 1) < 1e-6, `expected ~1 m, got ${summary.movedDistance}`);
    assert.strictEqual(summary.reshaped, false);
  });

  it('snaps sub-tolerance jitter to zero (float noise is not a move)', () => {
    const a = box([0, 0, 0], [3, 0.3, 2.7]);
    const b = box([0.0005, 0, 0], [3.0005, 0.3, 2.7]); // 0.5 mm < MOVE_EPS
    const summary = summarizeGeometryChange(a, b)!;
    assert.strictEqual(summary.movedDistance, 0);
    assert.strictEqual(summary.reshaped, false);
  });

  it('detects a reshape when the box size changes', () => {
    const a = box([0, 0, 0], [3, 0.3, 2.7]);
    const b = box([0, 0, 0], [3.5, 0.3, 2.7]); // grew 0.5 m in x
    const summary = summarizeGeometryChange(a, b)!;
    assert.strictEqual(summary.reshaped, true);
    // Growing only in +x shifts the centre by half the growth — that is a
    // reshape, reported alongside any centre move.
    assert.ok(summary.movedDistance > 0);
    assert.ok(Math.abs(summary.sizeDelta.x - 0.5) < 1e-6);
  });

  it('treats a missing side as a (re)shaped change, never a phantom move', () => {
    const summary = summarizeGeometryChange(null, box([0, 0, 0], [1, 1, 1]))!;
    assert.strictEqual(summary.movedDistance, 0);
    assert.strictEqual(summary.reshaped, true);
  });
});
