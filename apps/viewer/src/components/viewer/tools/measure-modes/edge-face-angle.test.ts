/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fixtures here are deliberately ASYMMETRIC and never 45 degrees.
 *
 * A 45 degree fixture survives the fold at 90 unchanged, so it cannot tell
 * `raw > 90 ? 180 - raw : raw` from `raw`, from `90 - raw`, or from a swap of
 * the two arguments. Every angle asserted below is distinct from its own
 * supplement and from its own complement.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { edgePairAngle, facePairAngle, formatAnglePair } from './edge-face-angle';

const P = (x: number, y: number, z: number) => ({ x, y, z });
const near = (a: number, b: number, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `expected ~${b}, got ${a}`);

describe('edgePairAngle', () => {
  it('measures the angle between two picked segments', () => {
    // 30 degrees: distinct from its supplement (150) and complement (60).
    const r = edgePairAngle(P(0, 0, 0), P(1, 0, 0), P(0, 0, 0), P(Math.cos(Math.PI / 6), 0, Math.sin(Math.PI / 6)));
    assert.equal(r.kind, 'angled');
    if (r.kind === 'angled') near(r.degrees, 30);
  });

  it('does not depend on the order the two points of an edge were picked', () => {
    // A line has no direction. If this changed with click order the user could
    // reproduce two different readings for one pair of edges at will.
    const a1 = P(0, 0, 0);
    const a2 = P(2.3, 0, 0);
    const b1 = P(1, 0, 0);
    const b2 = P(1 + Math.cos(Math.PI / 6) * 1.7, 0, Math.sin(Math.PI / 6) * 1.7);
    const forward = edgePairAngle(a1, a2, b1, b2);
    const reversed = edgePairAngle(a2, a1, b2, b1);
    const mixed = edgePairAngle(a2, a1, b1, b2);
    assert.equal(forward.kind, 'angled');
    if (forward.kind === 'angled' && reversed.kind === 'angled' && mixed.kind === 'angled') {
      near(reversed.degrees, forward.degrees);
      near(mixed.degrees, forward.degrees);
    }
  });

  it('folds an obtuse pairing onto its acute equivalent', () => {
    // 150 degrees between the directions is 30 between the lines. Asserting
    // 30 (not 150) is what pins the fold; 45 could not tell them apart.
    const r = edgePairAngle(
      P(0, 0, 0),
      P(1, 0, 0),
      P(0, 0, 0),
      P(Math.cos((150 * Math.PI) / 180), 0, Math.sin((150 * Math.PI) / 180)),
    );
    assert.equal(r.kind, 'angled');
    if (r.kind === 'angled') near(r.degrees, 30);
  });

  it('reports parallel for both parallel and ANTI-parallel edges', () => {
    const same = edgePairAngle(P(0, 0, 0), P(1, 2, 3), P(9, 9, 9), P(10, 11, 12));
    const opposed = edgePairAngle(P(0, 0, 0), P(1, 2, 3), P(10, 11, 12), P(9, 9, 9));
    assert.equal(same.kind, 'parallel');
    assert.equal(opposed.kind, 'parallel', 'anti-parallel is the same LINE, so it is parallel');
  });

  it('names which edge was degenerate, not just that one was', () => {
    const tiny = 1 / 65536 / 4;
    const first = edgePairAngle(P(0, 0, 0), P(tiny, 0, 0), P(0, 0, 0), P(1, 0, 0));
    const second = edgePairAngle(P(0, 0, 0), P(1, 0, 0), P(0, 0, 0), P(0, tiny, 0));
    assert.deepEqual(first, { kind: 'degenerate', reason: 'first' });
    assert.deepEqual(second, { kind: 'degenerate', reason: 'second' });
  });

  it('accepts an edge exactly at the pick resolution', () => {
    // The guard is <=, so one resolution is degenerate and just above it is
    // usable. Pinning the boundary from both sides keeps the threshold honest:
    // a value below the snap floor would classify nothing reachable.
    const res = 1 / 65536;
    assert.equal(edgePairAngle(P(0, 0, 0), P(res, 0, 0), P(0, 0, 0), P(1, 0, 0)).kind, 'degenerate');
    assert.notEqual(
      edgePairAngle(P(0, 0, 0), P(res * 4, 0, 0), P(0, 0, 0), P(0, 0, 1)).kind,
      'degenerate',
    );
  });
});

describe('facePairAngle', () => {
  it('measures the angle between two planes from their normals', () => {
    // Normals 65 degrees apart -> 65 between the planes (distinct from 115).
    const t = (65 * Math.PI) / 180;
    const r = facePairAngle(P(0, 1, 0), P(Math.sin(t), Math.cos(t), 0));
    assert.equal(r.kind, 'angled');
    if (r.kind === 'angled') near(r.degrees, 65);
  });

  it('ignores normal sign, because IFC winding is unreliable', () => {
    // Meshes are drawn double-sided here, so an inverted normal is a modelling
    // artefact rather than a different plane. Flipping either must not move it.
    const t = (65 * Math.PI) / 180;
    const n1 = P(0, 1, 0);
    const n2 = P(Math.sin(t), Math.cos(t), 0);
    const base = facePairAngle(n1, n2);
    const flipA = facePairAngle(P(-n1.x, -n1.y, -n1.z), n2);
    const flipB = facePairAngle(n1, P(-n2.x, -n2.y, -n2.z));
    assert.equal(base.kind, 'angled');
    if (base.kind === 'angled' && flipA.kind === 'angled' && flipB.kind === 'angled') {
      near(flipA.degrees, base.degrees);
      near(flipB.degrees, base.degrees);
    }
  });

  it('is scale invariant, so an unnormalised normal reads the same', () => {
    const t = (65 * Math.PI) / 180;
    const a = facePairAngle(P(0, 1, 0), P(Math.sin(t), Math.cos(t), 0));
    const b = facePairAngle(P(0, 1000, 0), P(Math.sin(t) * 0.004, Math.cos(t) * 0.004, 0));
    if (a.kind === 'angled' && b.kind === 'angled') near(b.degrees, a.degrees, 1e-5);
    else assert.fail('expected both to be angled');
  });

  it('reports parallel for coincident and for opposed faces', () => {
    assert.equal(facePairAngle(P(0, 1, 0), P(0, 3, 0)).kind, 'parallel');
    assert.equal(
      facePairAngle(P(0, 1, 0), P(0, -3, 0)).kind,
      'parallel',
      'opposed normals still describe two PARALLEL planes',
    );
  });

  it('names which normal was unusable', () => {
    assert.deepEqual(facePairAngle(P(0, 0, 0), P(0, 1, 0)), { kind: 'degenerate', reason: 'first' });
    assert.deepEqual(facePairAngle(P(0, 1, 0), P(0, 0, 0)), { kind: 'degenerate', reason: 'second' });
    assert.deepEqual(facePairAngle(P(Number.NaN, 1, 0), P(0, 1, 0)), {
      kind: 'degenerate',
      reason: 'first',
    });
  });

  it('distinguishes a missing normal from a too-short pick', () => {
    // A face pick has no length, so "First pick too short" would describe
    // something the user cannot do. A missing normal means a stored pick lost
    // its normal upstream - a bug, not a measurement error.
    const missing = facePairAngle(undefined, { x: 0, y: 1, z: 0 });
    assert.deepEqual(missing, { kind: 'degenerate', reason: 'no-normal' });
    assert.equal(formatAnglePair(missing), 'No surface at one pick');

    // ...and a present-but-zero normal is still reported as such.
    assert.deepEqual(facePairAngle({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), {
      kind: 'degenerate',
      reason: 'first',
    });
  });
});
