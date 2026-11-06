/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aimedOr, pickWinner, sameTarget, tierOf, type Ranked } from './rank.js';
import type { SnapCandidate } from './types.js';

const endpoint = (x: number): SnapCandidate => ({ kind: 'endpoint', local: [x, 0], source: 'linework' });
const ranked = (cand: SnapCandidate, dist: number, tier: number, order: number): Ranked => ({ cand, point: cand.local, dist, tier, order });

describe('tierOf (#6232 WP3)', () => {
  it('finds the tier of a kind, -1 when unlisted', () => {
    const tiers = [['endpoint', 'vertex'], ['edge']] as const;
    assert.equal(tierOf('vertex', tiers), 0);
    assert.equal(tierOf('edge', tiers), 1);
    assert.equal(tierOf('grid', tiers), -1);
  });
});

describe('sameTarget', () => {
  it('matches edge targets by guide even though their point follows the cursor', () => {
    const seg = { kind: 'segment', a: [0, 0], b: [4, 0], role: 'edge' } as const;
    const a: SnapCandidate = { kind: 'edge', local: [1, 0], source: 'mesh', guide: seg };
    const b: SnapCandidate = { kind: 'edge', local: [2, 0], source: 'mesh', guide: { ...seg, a: [4, 0], b: [0, 0] } };
    assert.ok(sameTarget(a, b));
    assert.ok(!sameTarget(a, { ...b, guide: { ...seg, b: [5, 0] } }));
  });

  it('matches point targets by exact position, kind and entity', () => {
    assert.ok(sameTarget(endpoint(1), endpoint(1)));
    assert.ok(!sameTarget(endpoint(1), endpoint(1.0000001)));
    assert.ok(!sameTarget(endpoint(1), { ...endpoint(1), kind: 'vertex' }));
    const e = { modelId: 'm', expressId: 5 };
    assert.ok(!sameTarget({ ...endpoint(1), entity: e }, { ...endpoint(1), entity: { ...e, expressId: 6 } }));
    assert.ok(!sameTarget({ ...endpoint(1), entity: e }, endpoint(1)));
  });
});

describe('pickWinner', () => {
  const R = 1;
  const H = 0.25;

  it('orders by tier, then distance, then collection order', () => {
    const items = [ranked(endpoint(1), 0.9, 1, 0), ranked(endpoint(2), 0.8, 0, 1), ranked(endpoint(3), 0.8, 0, 2)];
    assert.equal(pickWinner(items, R, 0, null)?.cand, items[1].cand);
  });

  it('a held target leaves only beyond radius + hysteresis', () => {
    const c = endpoint(1);
    assert.equal(pickWinner([ranked(c, R + H * 0.9, 0, 0)], R, H, null), null, 'not held: outside radius');
    assert.equal(pickWinner([ranked(c, R + H * 0.9, 0, 0)], R, H, c)?.cand, c, 'held: inside leave band');
    assert.equal(pickWinner([ranked(c, R + H * 1.1, 0, 0)], R, H, c), null);
  });

  it('a same-tier challenger must beat the held target by the margin; a better tier wins at once', () => {
    const held = endpoint(1);
    const other = endpoint(2);
    assert.equal(pickWinner([ranked(held, 0.5, 1, 0), ranked(other, 0.4, 1, 1)], R, H, held)?.cand, held);
    assert.equal(pickWinner([ranked(held, 0.5, 1, 0), ranked(other, 0.2, 1, 1)], R, H, held)?.cand, other);
    assert.equal(pickWinner([ranked(held, 0.1, 1, 0), ranked(other, 0.9, 0, 1)], R, H, held)?.cand, other);
    assert.equal(pickWinner([ranked(held, R + 0.1, 0, 0), ranked(other, 0.01, 1, 1)], R, H, held)?.cand, held,
      'a held better-tier target in its leave band beats a worse tier');
  });
});

describe('aimedOr: the pointer on a grid crossing (#9026 item 23)', () => {
  const crossing: SnapCandidate = { kind: 'gridIntersection', local: [6, 6], source: 'ifc-grid' };
  const corner: SnapCandidate = { kind: 'endpoint', local: [6.15, 6.15], source: 'linework' };
  const on = (cand: SnapCandidate, dist: number, tier: number) => ranked(cand, dist, tier, 0);
  /** The pointer sits `off` metres from the crossing, unless a test places it. */
  const pick = (winner: Ranked | null, items: Ranked[], off: number, prev: SnapCandidate | null = null, cursor: readonly [number, number] = [6, 6 + off]) =>
    aimedOr(winner, items, ['gridIntersection'], 0.02, 0.03, prev, cursor)?.cand ?? null;

  it('the crossing beats a higher-ranked corner while the pointer is on it', () => {
    const c = on(corner, 0.21, 0);
    assert.equal(pick(c, [c, on(crossing, 0.01, 1)], 0.01), crossing);
  });

  it('off the crossing the ladder decides, even when the crossing is the nearer target', () => {
    const c = on(corner, 0.08, 0);
    assert.equal(pick(c, [c, on(crossing, 0.05, 1)], 0.05), corner);
  });

  it('a pointer nearer the other target keeps it, at any zoom', () => {
    const c = on(corner, 0.005, 0);
    assert.equal(pick(c, [c, on(crossing, 0.015, 1)], 0.015), corner);
  });

  it('a wall end on the crossing keeps naming its wall', () => {
    const wallEnd: SnapCandidate = { kind: 'endpoint', local: [6, 6], source: 'semantic', entity: { modelId: 'm', expressId: 5 } };
    const w = on(wallEnd, 0.01, 0);
    assert.equal(pick(w, [w, on(crossing, 0.01, 1)], 0.01), wallEnd);
  });

  it('a held crossing survives ±1px at the edge of the aim, a fresh one does not', () => {
    const c = on(corner, 0.2, 0);
    const items = [c, on(crossing, 0.03, 1)];
    assert.equal(pick(c, items, 0.03), corner);
    assert.equal(pick(c, items, 0.03, crossing), crossing);
  });

  it('a crossing that only projects under the pointer through a lock is not aimed at', () => {
    const c = on(corner, 0.15, 0);
    const projected: Ranked = { cand: crossing, point: [6, 0], dist: 0, tier: 1, order: 1 };
    assert.equal(pick(c, [c, projected], 0, null, [6, 0]), corner);
  });

  it('a lock running through the crossing still lets the pointer aim at it', () => {
    const c = on(corner, 0.21, 0);
    assert.equal(pick(c, [c, { cand: crossing, point: [6, 6], dist: 0.01, tier: 1, order: 1 }], 0.01), crossing);
  });

  it('no aimed target in range leaves the ladder alone, including no winner at all', () => {
    const c = on(corner, 0.2, 0);
    assert.equal(pick(c, [c], 0), corner);
    assert.equal(pick(null, [], 0), null);
  });
});
