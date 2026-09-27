/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { solveSnap } from '../solve.js';
import { MODELING_SNAP_PROFILE } from '../rank.js';
import type { GridSpec } from '../grid.js';
import type { SnapCandidate } from '../types.js';
import { createGridSource } from './grid.js';
import { createLineworkSource } from './linework.js';
import { query } from '@/test/snap-fixture.js';

const GRID: GridSpec = { origin: [0, 0], spacing: 0.5 };
const PROFILE = { ...MODELING_SNAP_PROFILE, sources: ['grid', 'linework'] };

describe('createGridSource (#6232 WP3)', () => {
  it('offers the nearest node; a hidden grid offers nothing', () => {
    const out: SnapCandidate[] = [];
    createGridSource(GRID).collect(query([1.1, -0.2]), 1, out);
    assert.deepEqual(out, [{ kind: 'grid', local: [1, 0], source: 'grid' }]);
    const none: SnapCandidate[] = [];
    createGridSource(() => null).collect(query([1.1, -0.2]), 1, none);
    assert.equal(none.length, 0);
  });

  it('is the lowest tier: an edge in range beats a nearer node, and a node beats no snap', () => {
    const edge = createLineworkSource({ segments: [[[-5, 0.05], [5, 0.05]]] });
    const withEdge = solveSnap(query([2.01, 0.02]), [createGridSource(GRID), edge], PROFILE);
    assert.equal(withEdge.winner?.kind, 'edge');
    const alone = solveSnap(query([2.01, 0.02]), [createGridSource(GRID)], PROFILE);
    assert.equal(alone.winner?.kind, 'grid');
    assert.deepEqual(alone.local, [2, 0]);
    assert.equal(solveSnap(query([2.25, 0.25]), [createGridSource(GRID)], PROFILE).winner, null, 'no node within 12px');
  });
});
