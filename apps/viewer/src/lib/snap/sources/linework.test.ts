/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { solveSnap } from '../solve.js';
import { MODELING_SNAP_PROFILE } from '../rank.js';
import { SPACE_SKETCH_PROFILE } from '../space-sketch.js';
import type { SnapCandidate, SnapProfile, SnapQuery, SnapSource, Vec2 } from '../types.js';
import { createLineworkSource } from './linework.js';
import { query, rng } from '@/test/snap-fixture.js';

/** The same source with the solver's pruning hint withheld: the unpruned oracle. */
const unpruned = (s: SnapSource): SnapSource => ({
  id: s.id,
  collect: (q: SnapQuery, r: number, out: SnapCandidate[]) => s.collect(q, r, out),
});

describe('createLineworkSource (#6232 WP3)', () => {
  it('emits vertices, endpoints, midpoints, then edges, in that order', () => {
    const src = createLineworkSource({ vertices: [[9, 9]], segments: [[[0, 0], [2, 0]]], midpoints: true });
    const out: SnapCandidate[] = [];
    src.collect(query([1, 1]), 100, out);
    assert.deepEqual(out.map((c) => c.kind), ['vertex', 'endpoint', 'endpoint', 'midpoint', 'edge']);
    assert.deepEqual(out[4].local, [1, 0]);
    assert.deepEqual(out[4].guide, { kind: 'segment', a: [0, 0], b: [2, 0], role: 'edge' });
  });

  it('reads a getter on every collect', () => {
    let lines: { vertices: Vec2[] } = { vertices: [[0, 0]] };
    const src = createLineworkSource(() => lines);
    lines = { vertices: [[5, 5]] };
    const out: SnapCandidate[] = [];
    src.collect(query([5, 5]), 1, out);
    assert.deepEqual(out.map((c) => c.local), [[5, 5]]);
  });

  it('pruning with the hint never changes the answer (6k seeded queries, locked and free)', () => {
    const r = rng(42);
    const profiles: SnapProfile[] = [
      { ...SPACE_SKETCH_PROFILE },
      { ...MODELING_SNAP_PROFILE, sources: ['linework'] },
    ];
    let pruned = 0, snapped = 0;
    for (let i = 0; i < 6000; i++) {
      const c = (): number => r() * 20 - 10;
      const segments: [Vec2, Vec2][] = Array.from({ length: 1 + Math.floor(r() * 30) }, () => {
        const a: Vec2 = [c(), c()];
        return [a, r() < 0.5 ? [c(), a[1]] : [c(), c()]];
      });
      const vertices: Vec2[] = Array.from({ length: Math.floor(r() * 10) }, () => [c(), c()]);
      const p = profiles[i % 2];
      // Inference profiles must opt into far edges; Space Sketch may either way.
      const lines = { vertices, segments, midpoints: r() < 0.5, inference: p === profiles[1] || r() < 0.5 };
      const src = createLineworkSource(lines);
      const anchor: Vec2 | null = r() < 0.7 ? [c(), c()] : null;
      const locks: SnapQuery['locks'] = {};
      if (r() < 0.2) locks.angleDeg = r() * 360;
      if (r() < 0.2) locks.axis = r() < 0.5 ? 'u' : 'v';
      if (r() < 0.2) locks.length = r() * 8;
      const q = query([c(), c()], {
        anchor, chain: anchor ? [anchor] : [], locks, metresPerPixel: 0.02 + r() * 0.1,
        modifiers: { shift: r() < 0.4, alt: false },
      });
      const want = solveSnap(q, [unpruned(src)], p);
      const got = solveSnap(q, [src], p);
      assert.deepEqual(got.local, want.local, `case ${i}: ${JSON.stringify({ q, lines })}`);
      assert.equal(got.winner?.kind, want.winner?.kind, `case ${i}`);
      const all: SnapCandidate[] = [];
      src.collect(q, 1, all);
      const some: SnapCandidate[] = [];
      src.collect(q, 1, some, { locus: { kind: 'free' }, cursor: q.cursor });
      if (some.length < all.length) pruned++;
      if (want.winner) snapped++;
    }
    assert.ok(pruned > 1000 && snapped > 1000, JSON.stringify({ pruned, snapped }));
  });
});
