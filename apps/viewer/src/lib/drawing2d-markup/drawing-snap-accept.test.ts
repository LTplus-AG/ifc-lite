/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findSnap } from '../drafting-core/snaps';
import type { DraftShape, SnapMode } from '../drafting-core/types';
import { findAcceptedSnap } from './drawing-snap-accept';

const ALL: ReadonlySet<SnapMode> = new Set<SnapMode>(['endpoint', 'intersection', 'midpoint', 'center', 'quadrant', 'perpendicular', 'nearest']);

/** Lines, a closed and an open polyline, a circle and an arc, crossing each other. */
const SHAPES: DraftShape[] = [
  { type: 'line', a: { x: 0, y: 0 }, b: { x: 4, y: 0 } },
  { type: 'line', a: { x: 1, y: -1 }, b: { x: 3, y: 2 } },
  { type: 'polyline', pts: [{ x: 0, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 3 }, { x: 0, y: 3 }], closed: true },
  { type: 'polyline', pts: [{ x: 3, y: 3 }, { x: 4, y: 1.5 }, { x: 5, y: 3 }], closed: false },
  { type: 'circle', c: { x: 3, y: 1 }, r: 0.8 },
  { type: 'arc', c: { x: 1, y: 2 }, r: 1.2, start: 0.3, end: 2.5 },
];

describe('findAcceptedSnap (#10076 review)', () => {
  it('agrees with the vendored findSnap when every candidate is accepted', () => {
    let hits = 0;
    for (const from of [null, { x: -1, y: 0.5 }]) {
      for (let x = -0.5; x <= 5.5; x += 0.13) {
        for (let y = -1.5; y <= 3.5; y += 0.13) {
          const cursor = { x, y };
          const opts = { tolerance: 0.25, modes: ALL, from };
          const want = findSnap(cursor, SHAPES, null, opts);
          const got = findAcceptedSnap(cursor, SHAPES, { ...opts, accept: () => true });
          assert.deepEqual(got, want, `cursor ${x.toFixed(2)},${y.toFixed(2)} from ${JSON.stringify(from)}`);
          if (want) hits++;
        }
      }
    }
    assert.ok(hits > 500, `the grid exercises snaps (${hits} hits)`);
  });

  it('offers the best accepted candidate of a mode when a closer one is rejected', () => {
    const shapes: DraftShape[] = [{ type: 'line', a: { x: 0, y: 0 }, b: { x: 0.3, y: 0 } }];
    const cursor = { x: 0.05, y: 0.01 };
    const opts = { tolerance: 0.5, modes: ALL };
    assert.deepEqual(findSnap(cursor, shapes, null, opts), { mode: 'endpoint', point: { x: 0, y: 0 } });
    assert.deepEqual(findAcceptedSnap(cursor, shapes, { ...opts, accept: (p) => p.x > 0.01 }), { mode: 'endpoint', point: { x: 0.3, y: 0 } });
  });
});
