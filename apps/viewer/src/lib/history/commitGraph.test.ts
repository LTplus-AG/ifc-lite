/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceCommit } from '@ifc-lite/plugin-api';

import { buildCommitRows, joinCommitPages, mainlineIds, orderCompareSlots } from './commitGraph.js';

function commit(id: string, parents: string[], createdAt: string): SourceCommit {
  return {
    id,
    modelId: 'm1',
    projectId: 'p1',
    parents,
    createdAt,
    status: 'published',
    artifact: { digest: `sha256:${id}`, fileName: `${id}.ifc`, sizeBytes: 1 },
  };
}

/** c3 → c2 → c1, newest first, as `listCommits` returns them. */
const CHAIN = [
  commit('c3', ['c2'], '2026-09-25T09:15:00.000Z'),
  commit('c2', ['c1'], '2026-09-12T11:30:00.000Z'),
  commit('c1', [], '2026-03-03T08:00:00.000Z'),
];

describe('joinCommitPages', () => {
  it('appends a second page in the provider order', () => {
    const joined = joinCommitPages(CHAIN.slice(0, 2), CHAIN.slice(2));
    assert.deepEqual(joined.map((c) => c.id), ['c3', 'c2', 'c1']);
  });

  it('drops a commit the provider repeated across the page boundary', () => {
    // A new commit landing mid-scroll shifts every later page by one, so a
    // provider re-sending the join commit is ordinary. Two rows with one
    // React key is a render that silently drops one.
    const joined = joinCommitPages(CHAIN.slice(0, 2), [CHAIN[1], CHAIN[2]]);
    assert.deepEqual(joined.map((c) => c.id), ['c3', 'c2', 'c1']);
  });

  it('never re-sorts what the provider sent', () => {
    // Two commits in the same second: the provider's total order (id) is the
    // authority, and a client-side sort on createdAt alone would be unstable
    // and make the list jump between pages.
    const sameSecond = [
      commit('b', ['a'], '2026-01-01T00:00:00.000Z'),
      commit('a', [], '2026-01-01T00:00:00.000Z'),
    ];
    assert.deepEqual(joinCommitPages([], sameSecond).map((c) => c.id), ['b', 'a']);
  });

  it('copies rather than aliasing the existing array', () => {
    const existing = CHAIN.slice(0, 1);
    const joined = joinCommitPages(existing, []);
    assert.notEqual(joined, existing);
    assert.deepEqual(joined.map((c) => c.id), ['c3']);
  });
});

describe('mainlineIds', () => {
  it('follows parents[0] from the head', () => {
    assert.deepEqual([...mainlineIds(CHAIN, 'c3')].sort(), ['c1', 'c2', 'c3']);
  });

  it('marks only the commits actually loaded', () => {
    // One page fetched out of many: the chain stops where the pages stop
    // rather than claiming everything older is off-mainline.
    const firstPage = CHAIN.slice(0, 2);
    assert.deepEqual([...mainlineIds(firstPage, 'c3')].sort(), ['c2', 'c3']);
  });

  it('follows only the FIRST parent of a merge', () => {
    const merge = commit('m', ['c3', 'side'], '2026-10-01T00:00:00.000Z');
    const side = commit('side', [], '2026-08-01T00:00:00.000Z');
    const ids = mainlineIds([merge, ...CHAIN, side], 'm');
    assert.ok(ids.has('c3'), 'the mainline parent is on the mainline');
    assert.ok(!ids.has('side'), 'the second parent of a merge is not; v1 renders one lane');
  });

  it('falls back to the newest loaded commit when the head is not in the pages', () => {
    assert.deepEqual([...mainlineIds(CHAIN, 'not-fetched-yet')].sort(), ['c1', 'c2', 'c3']);
  });

  it('terminates on a cyclic parent chain instead of hanging', () => {
    // `parents` comes from a provider, so a malformed one can point a commit
    // at itself; a panel must not lock the tab over it.
    const self = commit('x', ['x'], '2026-01-01T00:00:00.000Z');
    assert.deepEqual([...mainlineIds([self], 'x')], ['x']);
  });
});

describe('buildCommitRows', () => {
  it('marks head, loaded and merge rows', () => {
    const merge = commit('m', ['c3', 'side'], '2026-10-01T00:00:00.000Z');
    const rows = buildCommitRows({
      commits: [merge, ...CHAIN],
      headCommitId: 'm',
      loadedCommitId: 'c2',
    });
    assert.deepEqual(rows.map((r) => r.commit.id), ['m', 'c3', 'c2', 'c1']);
    assert.equal(rows[0].isMerge, true);
    assert.equal(rows[0].isHead, true);
    assert.equal(rows[2].isLoaded, true);
    assert.equal(rows[1].isMerge, false);
    assert.ok(rows.every((r) => r.onMainline), 'every row here is reachable by parents[0]');
  });

  it('flags a commit that is not on the mainline', () => {
    const merge = commit('m', ['c3', 'side'], '2026-10-01T00:00:00.000Z');
    const side = commit('side', [], '2026-08-01T00:00:00.000Z');
    const rows = buildCommitRows({ commits: [merge, ...CHAIN, side], headCommitId: 'm' });
    assert.equal(rows.find((r) => r.commit.id === 'side')!.onMainline, false);
  });

  it('reports no loaded row when nothing of this model is open', () => {
    const rows = buildCommitRows({ commits: CHAIN, headCommitId: 'c3' });
    assert.ok(rows.every((r) => !r.isLoaded));
  });
});

describe('orderCompareSlots', () => {
  it('puts the older commit in the base slot whichever way round it is given', () => {
    const older = CHAIN[2];
    const newer = CHAIN[0];
    // The failure this prevents: a diff reads base → head, so a reversed
    // pair reports every addition as a deletion.
    assert.equal(orderCompareSlots(newer, older).base.id, older.id);
    assert.equal(orderCompareSlots(older, newer).base.id, older.id);
    assert.equal(orderCompareSlots(newer, older).head.id, newer.id);
  });

  it('breaks a timestamp tie deterministically', () => {
    const a = commit('a', [], '2026-01-01T00:00:00.000Z');
    const b = commit('b', [], '2026-01-01T00:00:00.000Z');
    assert.equal(orderCompareSlots(a, b).base.id, 'a');
    assert.equal(orderCompareSlots(b, a).base.id, 'a');
  });
});
