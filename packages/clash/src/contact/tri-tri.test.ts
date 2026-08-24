/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boundary-pinning test for `triTriIntersect`'s chord reconstruction
 * (`triChord` in `contact/tri-tri.ts`).
 *
 * Mutation testing found this file has zero dedicated tests (only exercised
 * indirectly through `contact.test.ts` / `world-frame.test.ts`, which never
 * happen to hit an EXACT on-plane vertex): widening any one of the three
 * `triChord` edge-crossing clauses from a strict `d0 < 0` to `d0 <= 0` (or the
 * symmetric `>` -> `>=`) passed the full suite unchanged. That widened clause
 * double-counts a vertex that sits exactly on the other triangle's plane —
 * once via the edge-crossing clause (now falsely true), once via the
 * dedicated `d0 === 0` on-plane-vertex push a few lines below — corrupting
 * `pts` with a duplicate `first`/`last` and collapsing the reported chord to
 * a zero-length segment at that vertex instead of the true intersection
 * segment.
 *
 * This pins the currently-CORRECT behaviour so a future edit with that same
 * shape (loosening a strict inequality) is caught immediately rather than
 * silently reintroducing the corruption.
 */

import { describe, expect, it } from 'vitest';
import { triTriIntersect } from './tri-tri.js';
import type { Triangle } from './triangle.js';

describe('triTriIntersect — chord through a vertex exactly on the other plane', () => {
  it('reports the true crossing segment, not a degenerate point, when one vertex sits exactly on the opposite plane', () => {
    // B lies exactly in the z=0 plane.
    const b: Triangle = { v0: [0, 0, 0], v1: [1, 0, 0], v2: [0, 1, 0] };
    // A shares a vertex (0.2, 0.2, 0) exactly on B's plane, with its other
    // two vertices straddling z=0 (one above, one below) so A genuinely
    // crosses B's plane rather than merely touching it.
    const a: Triangle = { v0: [0.2, 0.2, 0], v1: [0.5, 0.5, 1], v2: [0.5, 0.5, -1] };

    const r = triTriIntersect(a, b, 1e-9);
    expect(r.kind).toBe('cross');
    if (r.kind !== 'cross') return;

    // The true chord runs from A's on-plane vertex to where edge A.v1-A.v2
    // crosses z=0 (the midpoint, by symmetry) — length ~0.424 m, not 0.
    const dx = r.p1[0] - r.p0[0];
    const dy = r.p1[1] - r.p0[1];
    const dz = r.p1[2] - r.p0[2];
    const len = Math.hypot(dx, dy, dz);
    expect(len).toBeGreaterThan(0.1);

    // Both reported endpoints must lie in B's plane (z=0) and be genuinely
    // distinct points, not the same vertex reported twice.
    expect(Math.abs(r.p0[2])).toBeLessThan(1e-9);
    expect(Math.abs(r.p1[2])).toBeLessThan(1e-9);
    const endpoints = [r.p0, r.p1].map((p) => p.map((c) => Math.round(c * 1e6)).join(','));
    expect(endpoints[0]).not.toBe(endpoints[1]);
  });
});
