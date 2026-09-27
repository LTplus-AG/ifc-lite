/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { solveSnap } from './solve.js';
import { buildLocus, distanceToLocus, projectOntoLocus } from './constraints.js';
import { MODELING_SNAP_PROFILE } from './rank.js';
import type { SnapProfile, SnapQuery, SnapResult, SnapSource, Vec2 } from './types.js';
import { query, rng, sceneSource } from '@/test/snap-fixture.js';

const PROFILE: SnapProfile = { ...MODELING_SNAP_PROFILE, sources: ['linework'] };
/** 12 px × 0.01 m/px. */
const RADIUS = 0.12;

function randomScene(r: () => number): SnapSource {
  const pts: Vec2[] = [];
  const segs: [Vec2, Vec2][] = [];
  const n = 1 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) pts.push([r() * 4 - 2, r() * 4 - 2]);
  for (let i = 0; i < n; i++) segs.push([[r() * 4 - 2, r() * 4 - 2], [r() * 4 - 2, r() * 4 - 2]]);
  return sceneSource(pts, segs);
}

function randomQuery(r: () => number): SnapQuery {
  const anchor: Vec2 | null = r() < 0.85 ? [r() * 4 - 2, r() * 4 - 2] : null;
  const locks: SnapQuery['locks'] = {};
  if (r() < 0.35) locks.length = r() * 3;
  if (r() < 0.25) locks.angleDeg = Math.floor(r() * 24) * 15 + (r() < 0.3 ? r() * 10 : 0);
  if (r() < 0.2) locks.axis = r() < 0.5 ? 'u' : 'v';
  const chain: Vec2[] = anchor && r() < 0.5 ? [[r() * 4 - 2, r() * 4 - 2], anchor] : anchor ? [anchor] : [];
  return query([r() * 4 - 2, r() * 4 - 2], {
    anchor, chain, locks, metresPerPixel: 0.01 + r() * 0.03,
    modifiers: { shift: r() < 0.4, alt: false },
  });
}

describe('solveSnap invariants (#6232 WP3)', () => {
  it('the result lies on the lock locus within 1e-9 (5k random scenes and locks)', () => {
    const r = rng(1);
    let locked = 0, snapped = 0;
    for (let i = 0; i < 5000; i++) {
      const src = randomScene(r);
      const q = randomQuery(r);
      const res = solveSnap(q, [src], PROFILE);
      const locus = buildLocus(q, PROFILE);
      const off = distanceToLocus(res.local, locus);
      assert.ok(off <= 1e-9, `iteration ${i}: ${off} off the ${locus.kind} locus (winner ${res.winner?.kind})`);
      assert.equal(res.locked, locus.kind !== 'free');
      if (locus.kind !== 'free') locked++;
      if (locus.kind !== 'free' && res.winner) snapped++;
    }
    // The property is only meaningful if it exercised locked snaps.
    assert.ok(locked > 2000 && snapped > 500, `locked=${locked} snapped=${snapped}`);
  });

  it('respects the radius: a winner lands within it of the constrained cursor', () => {
    const r = rng(2);
    let winners = 0;
    for (let i = 0; i < 5000; i++) {
      const q = randomQuery(r);
      const res = solveSnap(q, [randomScene(r)], PROFILE);
      if (!res.winner) continue;
      winners++;
      const cursor = projectOntoLocus(q.cursor, buildLocus(q, PROFILE));
      const d = Math.hypot(res.local[0] - cursor[0], res.local[1] - cursor[1]);
      assert.ok(d <= PROFILE.radiusPx * q.metresPerPixel + 1e-12, `iteration ${i}: ${d}`);
    }
    assert.ok(winners > 500);
  });

  it('holds tier order: no better-tier target within the radius is passed over (free cursor)', () => {
    const tiers = [['vertex'], ['endpoint'], ['edge']] as const;
    const profile: SnapProfile = { radiusPx: 12, tiers, sources: ['linework'] };
    const r = rng(3);
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const src = randomScene(r);
      const q = query([r() * 4 - 2, r() * 4 - 2], { metresPerPixel: 0.05 });
      const res = solveSnap(q, [src], profile);
      const all: Parameters<SnapSource['collect']>[2] = [];
      src.collect(q, Infinity, all);
      const inRange = all.filter((c) => Math.hypot(c.local[0] - q.cursor[0], c.local[1] - q.cursor[1]) <= 0.6);
      const bestTier = Math.min(...inRange.map((c) => tiers.findIndex((t) => (t as readonly string[]).includes(c.kind))));
      if (!inRange.length) { assert.equal(res.winner, null); continue; }
      checked++;
      assert.ok(res.winner);
      assert.equal(tiers.findIndex((t) => (t as readonly string[]).includes(res.winner!.kind)), bestTier);
      const nearest = Math.min(...inRange.filter((c) => c.kind === res.winner!.kind).map((c) => Math.hypot(c.local[0] - q.cursor[0], c.local[1] - q.cursor[1])));
      assert.equal(Math.hypot(res.local[0] - q.cursor[0], res.local[1] - q.cursor[1]), nearest);
    }
    assert.ok(checked > 500);
  });

  it('prefers a farther endpoint over a nearer edge, and falls back to the edge outside the radius', () => {
    const src = sceneSource([], [[[0, 0], [10, 0]]]);
    const near = solveSnap(query([0.1, 0.02]), [src], PROFILE);
    assert.equal(near.winner?.kind, 'endpoint');
    assert.deepEqual(near.local, [0, 0]);
    const far = solveSnap(query([0.5, 0.02]), [src], PROFILE);
    assert.equal(far.winner?.kind, 'edge');
    assert.deepEqual(far.local, [0.5, 0]);
    const none = solveSnap(query([0.5, 0.5]), [src], PROFILE);
    assert.equal(none.winner, null);
    assert.deepEqual(none.local, [0.5, 0.5]);
  });
});

describe('solveSnap hysteresis', () => {
  /** Drive a cursor path, threading `prev`, and count winner changes. */
  function flips(src: SnapSource, path: readonly Vec2[], profile: SnapProfile): number {
    let prev: SnapResult | undefined;
    let changes = 0;
    let last: string | null | undefined;
    for (const c of path) {
      const res = solveSnap(query(c), [src], profile, prev);
      const key = res.winner ? `${res.winner.kind}:${res.winner.local.join(',')}` : null;
      if (last !== undefined && key !== last) changes++;
      last = key;
      prev = res;
    }
    return changes;
  }
  const jitter = (x0: number, y: number, px: number, n: number): Vec2[] =>
    Array.from({ length: n }, (_, i) => [x0 + (i % 2 === 0 ? px : -px) * 0.01, y] as Vec2);

  it('does not flip-flop between two equidistant targets on ±1px jitter', () => {
    const src = sceneSource([[0, 0], [0.1, 0]], []);
    const path = jitter(0.05, 0.01, 1, 40);
    assert.ok(flips(src, path, { ...PROFILE, hysteresisPx: 0 }) > 30, 'control: without hysteresis it flips');
    assert.equal(flips(src, path, PROFILE), 0);
  });

  it('does not flip-flop at the radius boundary on ±1px jitter', () => {
    const src = sceneSource([[0, 0]], []);
    const path = jitter(RADIUS, 0, 1, 40);
    assert.ok(flips(src, path, { ...PROFILE, hysteresisPx: 0 }) > 30, 'control: without hysteresis it flips');
    assert.ok(flips(src, path, PROFILE) <= 1);
  });

  it('releases a held target once the cursor moves past radius + hysteresis', () => {
    const src = sceneSource([[0, 0]], []);
    const held = solveSnap(query([0.05, 0]), [src], PROFILE);
    assert.equal(held.winner?.kind, 'vertex');
    assert.equal(solveSnap(query([RADIUS + 0.02, 0]), [src], PROFILE, held).winner?.kind, 'vertex');
    assert.equal(solveSnap(query([RADIUS + 0.04, 0]), [src], PROFILE, held).winner, null);
  });
});

describe('solveSnap inference', () => {
  it('extension intersections are exact (axis-aligned)', () => {
    const src = sceneSource([], [[[0, 0], [1, 0]], [[5, 3], [5, 4]]]);
    const res = solveSnap(query([5.03, 0.02]), [src], PROFILE);
    assert.equal(res.winner?.kind, 'intersection');
    assert.deepEqual(res.local, [5, 0]);
    assert.equal(res.guides.length, 2);
  });

  it('extension intersections are exact (diagonal, integer inputs)', () => {
    const src = sceneSource([], [[[0, 0], [1, 1]], [[4, 0], [3, 1]]]);
    const res = solveSnap(query([2.04, 1.97]), [src], PROFILE);
    assert.equal(res.winner?.kind, 'intersection');
    assert.deepEqual(res.local, [2, 2]);
  });

  it('snaps onto an edge extension beyond its end, exactly on the line', () => {
    const src = sceneSource([], [[[0, 0.3], [1, 0.3]]]);
    const res = solveSnap(query([3.7, 0.33]), [src], PROFILE);
    assert.equal(res.winner?.kind, 'extension');
    assert.deepEqual(res.local, [3.7, 0.3]);
  });

  it('snaps to the perpendicular foot of the anchor', () => {
    const src = sceneSource([], [[[0, 0], [10, 0]]]);
    const res = solveSnap(query([4.05, 0.03], { anchor: [4, 5] }), [src], PROFILE);
    assert.equal(res.winner?.kind, 'perpendicular');
    assert.deepEqual(res.local, [4, 0]);
  });

  it('tracks the axis of an earlier chain point (closing a rectangle)', () => {
    const chain: Vec2[] = [[0, 0], [4, 0], [4, 3]];
    const res = solveSnap(query([0.03, 3.04], { anchor: [4, 3], chain }), [], { ...PROFILE, sources: [] });
    assert.equal(res.winner?.kind, 'intersection');
    assert.deepEqual(res.local, [0, 3]);
  });
});

describe('solveSnap locks', () => {
  it('slides along an ortho lock to where it crosses an edge', () => {
    const src = sceneSource([], [[[2, -1], [4, 1]]]);
    const res = solveSnap(
      query([3.05, 0.2], { anchor: [0, 0], modifiers: { shift: true, alt: false } }), [src], { ...PROFILE, angleStepDeg: 90 },
    );
    assert.equal(res.winner?.kind, 'edge');
    assert.deepEqual(res.local, [3, 0]);
    assert.ok(res.locked);
    assert.equal(res.guides[0].role, 'lock');
  });

  it('a typed length snaps to where the circle crosses an edge', () => {
    const src = sceneSource([], [[[-10, 3], [10, 3]]]);
    const res = solveSnap(query([4.05, 2.9], { anchor: [0, 0], locks: { length: 5 } }), [src], PROFILE);
    assert.equal(res.winner?.kind, 'edge');
    assert.ok(Math.abs(res.local[0] - 4) < 1e-12 && Math.abs(res.local[1] - 3) < 1e-12);
  });

  it('length + angle is fully determined: no snapping, exact point', () => {
    const src = sceneSource([[3, 0.01]], []);
    const res = solveSnap(query([3, 0], { anchor: [0, 0], locks: { length: 3, angleDeg: 0 } }), [src], PROFILE);
    assert.equal(res.winner, null);
    assert.deepEqual(res.local, [3, 0]);
  });

  it('alt suspends snapping but keeps the lock; unknown sources are not consulted', () => {
    const src = sceneSource([[1, 0.05]], []);
    const alt = solveSnap(query([1, 0.06], { anchor: [0, 0], locks: { axis: 'u' }, modifiers: { shift: false, alt: true } }), [src], PROFILE);
    assert.equal(alt.winner, null);
    assert.deepEqual(alt.local, [1, 0]);
    assert.equal(solveSnap(query([1, 0.05]), [sceneSource([[1, 0.05]], [], 'mesh')], PROFILE).winner, null);
  });
});
