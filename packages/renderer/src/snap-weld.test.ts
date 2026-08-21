/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weldVertices } from './snap-weld.js';

/**
 * Issue #2199 / PR #2655 review: the weld itself must be order-independent.
 *
 * The whole point of the snap-cache change is that nothing user-visible moves
 * when wasm triangle emission order does (#2388). A first-hit representative
 * scheme broke that one level down: with a tolerance chain |A-B| <= tol,
 * |B-C| <= tol but |A-C| > tol, input order [A,B,C] made A the representative
 * (so C started its own cluster: two welded ids) while [B,A,C] made B the
 * representative (so both A and C joined it: one welded id). Welding feeds
 * adjacency, edge classification and run reconstruction, so merely reordering
 * triangles changed the reconstructed edges.
 */

/** The tolerance floor for near-origin coordinates (see MIN_SNAP_TOLERANCE). */
const TOL = 1 / 65536;

type P3 = [number, number, number];

/**
 * Weld the named points in the given order and return the partition they weld
 * into, expressed over the NAMES so results from different input orders are
 * directly comparable.
 */
function weldPartition(coords: Record<string, P3>, order: string[], tol = TOL): string {
  const flat: number[] = [];
  for (const name of order) flat.push(...coords[name]);
  const { ids } = weldVertices(flat, 0, 0, 0, tol);
  const groups = new Map<number, string[]>();
  order.forEach((name, i) => {
    const group = groups.get(ids[i]) ?? [];
    group.push(name);
    groups.set(ids[i], group);
  });
  return [...groups.values()].map((g) => g.sort().join('+')).sort().join('|');
}

test('#2199 a tolerance chain welds identically in every input order', () => {
  // A-B and B-C are within tolerance, A-C is not: the case where a first-hit
  // scheme's answer depended on which point arrived first.
  const coords: Record<string, P3> = {
    A: [1, 0, 0],
    B: [1 + 0.9 * TOL, 0, 0],
    C: [1 + 1.8 * TOL, 0, 0],
  };

  const names = Object.keys(coords);
  const partitions = new Set<string>();
  // All 6 permutations of 3 points.
  for (const a of names) {
    for (const b of names) {
      for (const c of names) {
        if (a === b || b === c || a === c) continue;
        partitions.add(weldPartition(coords, [a, b, c]));
      }
    }
  }
  assert.equal(
    partitions.size, 1,
    `the weld partition moved with input order: ${[...partitions].join(' vs ')}`
  );

  // Pin the value too. The chosen semantics are leader clustering in canonical
  // VALUE order: A (lexicographically first) leads, B joins it (within tol of
  // the leader), C is 1.8 tol from the only leader so it starts its own
  // cluster. C is NOT pulled in through B - that transitive chain is exactly
  // the over-weld this scheme avoids (see the over-weld test below).
  assert.equal([...partitions][0], 'A+B|C');
});

test('#2199 a chain of distinct near-tolerance vertices does not collapse into one point', () => {
  // Five points spaced 0.9 tol apart: every consecutive pair is within
  // tolerance, but the ends are 3.6 tol apart. A transitive union (union-find
  // over all in-tolerance pairs) would weld the whole chain into ONE vertex of
  // unbounded diameter - and welding feeds edge classification, so an
  // over-weld silently moves geometry. Leader clustering bounds every cluster:
  // each member is within tol of its cluster's representative point, so a
  // cluster's diameter never exceeds 2 tol regardless of chain length.
  const flat: number[] = [];
  const n = 5;
  for (let i = 0; i < n; i++) flat.push(2 + i * 0.9 * TOL, 0, 0);
  const { ids, points } = weldVertices(flat, 0, 0, 0, TOL);

  const clusters = new Set<number>();
  for (let i = 0; i < n; i++) {
    clusters.add(ids[i]);
    const rep = points[ids[i]];
    const d = Math.abs(rep.x - flat[i * 3]);
    assert.ok(
      d <= TOL,
      `vertex ${i} is ${(d / TOL).toFixed(2)} tol from its representative - cluster diameter is unbounded`
    );
  }
  assert.ok(
    clusters.size > 1,
    'a 3.6 tol long chain collapsed into one welded vertex (transitive over-weld)'
  );
  // Pin the exact grouping under leader clustering: leaders at 0 and 1.8 tol
  // and 3.6 tol, members joining the nearest leader within tol.
  assert.equal(clusters.size, 3);
});

/**
 * Both tests above only ever vary the X coordinate (Y and Z sit at a shared
 * 0 for every point in the batch), so the squared-distance sum `dx*dx +
 * dy*dy + dz*dz` cannot be observed component-by-component: dropping the
 * `dy` or `dz` term entirely (or duplicating `dx` in its place) leaves both
 * suites green, since the dropped term's contribution was already zero.
 * These pin each axis independently, the way `aabb.test.ts` and
 * `spatial-index-builder.test.ts` already do for their own distance/bounds
 * math.
 *
 * Separation is deliberately 1.5*tol, not something larger: the hash-grid
 * probe already widens by +-tol around each point (`cell = 2*tol`), so a
 * separation of, say, 3*tol lands the two points in non-overlapping buckets
 * and gets rejected by the grid lookup alone -- before the (possibly
 * mutated) squared-distance check ever runs. 1.5*tol stays inside the
 * probed bucket range while still exceeding tol, so only the final `dSq`
 * comparison can reject it.
 */
test('#2199 a Y-only separation beyond tolerance keeps points apart', () => {
  // x and z identical; only y differs, past tol but within the grid probe
  // range. If dy dropped out of the squared distance, this pair would
  // incorrectly weld.
  const flat = [5, 0, -5, 5, 1.5 * TOL, -5];
  const { ids } = weldVertices(flat, 0, 0, 0, TOL);
  assert.notEqual(ids[0], ids[1], 'points 1.5*TOL apart on Y alone must not weld');
});

test('#2199 a Z-only separation beyond tolerance keeps points apart', () => {
  // x and y identical; only z differs, past tol but within the grid probe
  // range. If dz dropped out of the squared distance, this pair would
  // incorrectly weld.
  const flat = [5, -5, 0, 5, -5, 1.5 * TOL];
  const { ids } = weldVertices(flat, 0, 0, 0, TOL);
  assert.notEqual(ids[0], ids[1], 'points 1.5*TOL apart on Z alone must not weld');
});

test('#2199 a Y-only or Z-only separation within tolerance still welds', () => {
  // The positive sibling of the two tests above: small enough on Y or Z
  // alone that a correct 3-axis distance welds them.
  const flatY = [5, 0, -5, 5, 0.5 * TOL, -5];
  const { ids: idsY } = weldVertices(flatY, 0, 0, 0, TOL);
  assert.equal(idsY[0], idsY[1], 'points 0.5*TOL apart on Y alone must weld');

  const flatZ = [5, -5, 0, 5, -5, 0.5 * TOL];
  const { ids: idsZ } = weldVertices(flatZ, 0, 0, 0, TOL);
  assert.equal(idsZ[0], idsZ[1], 'points 0.5*TOL apart on Z alone must weld');
});
