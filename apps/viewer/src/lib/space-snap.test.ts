/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { snapPoint, type Pt } from './space-snap.js';

const seg = (a: Pt, b: Pt): [Pt, Pt] => [a, b];

describe('snapPoint', () => {
  it('snaps to the nearest room vertex (corner) within tolerance', () => {
    const r = snapPoint([1.04, 0.97], { vertices: [[1, 1], [5, 5]], tol: 0.2 });
    assert.deepStrictEqual(r.pt, [1, 1]);
    assert.strictEqual(r.kind, 'vertex');
  });

  it('snaps to a segment endpoint as a corner', () => {
    const r = snapPoint([0.05, -0.05], { segments: [seg([0, 0], [4, 0])], tol: 0.2 });
    assert.deepStrictEqual(r.pt, [0, 0]);
    assert.strictEqual(r.kind, 'vertex');
  });

  it('prefers a corner over an on-wall projection when both are in range', () => {
    // Cursor is near the wall body AND near its endpoint corner — corner wins.
    const r = snapPoint([0.1, 0.1], { segments: [seg([0, 0], [10, 0])], tol: 0.5 });
    assert.deepStrictEqual(r.pt, [0, 0]);
    assert.strictEqual(r.kind, 'vertex');
  });

  it('snaps onto the wall body (projection) when no corner is in range', () => {
    const r = snapPoint([5, 0.1], { segments: [seg([0, 0], [10, 0])], tol: 0.5 });
    assert.deepStrictEqual(r.pt, [5, 0]);
    assert.strictEqual(r.kind, 'line');
  });

  it('returns the raw point (no snap) when nothing is within tolerance', () => {
    const r = snapPoint([5, 5], { vertices: [[0, 0]], segments: [seg([0, 0], [1, 0])], tol: 0.2 });
    assert.deepStrictEqual(r.pt, [5, 5]);
    assert.strictEqual(r.kind, 'none');
  });

  it('applies ortho relative to the anchor when no snap target is in range', () => {
    // Mostly-horizontal move → locks Y to the anchor's Y.
    const r = snapPoint([4, 0.3], { tol: 0.1, ortho: true, anchor: [0, 0] });
    assert.deepStrictEqual(r.pt, [4, 0]);
    assert.strictEqual(r.kind, 'none');
  });

  it('still snaps to a corner that lies along the ortho line', () => {
    // Ortho locks [4,0.1] → [4,0]; a vertex near that ortho point still snaps,
    // so straight runs land cleanly on aligned corners.
    const r = snapPoint([4, 0.1], { vertices: [[4.05, 0.02]], tol: 0.3, ortho: true, anchor: [0, 0] });
    assert.deepStrictEqual(r.pt, [4.05, 0.02]);
    assert.strictEqual(r.kind, 'vertex');
  });
});
