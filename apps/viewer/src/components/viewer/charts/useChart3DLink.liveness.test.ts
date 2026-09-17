/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, type ChartDataset } from '@ifc-lite/charts';
import { chartBucketIdentity, chartSelectionIsLive } from './useChart3DLink.js';

const SPEC = { id: 'big', title: 'Big', source: 'elements' as const, type: 'bar' as const, dimension: 'Kind', measure: { agg: 'count' as const } };

function dataset(size: number, fingerprint: string): ChartDataset {
  return {
    source: 'elements',
    fingerprint,
    columns: [{ id: 'Kind', label: 'Kind', kind: 'category' }],
    rows: Array.from({ length: size }, (_, index) => ({ ids: [index + 1], values: [index % 3 === 0 ? 'B' : 'A'] })),
  };
}

describe('chart selection identity (#4833 review)', () => {
  it('a same-data Other selection dies with its series: a dimension change that keeps the fingerprint but drops the series is not live', () => {
    const data = dataset(9, 'rev-1');
    const folded = aggregate({ ...SPEC, topN: 1, sort: 'label' }, data);
    const other = chartBucketIdentity(folded, { seriesIndex: 0, dataIndex: 1 })!;
    assert.equal(other.isOther, true);
    // The spec now buckets by another column: same dataset fingerprint, the 'Kind' series is gone.
    const rekeyed = aggregate({ ...SPEC, dimension: 'Kind', topN: 1, sort: 'label' }, { ...data, columns: [{ id: 'Kind', label: 'Other kind', kind: 'category' }], rows: data.rows.map((row) => ({ ...row, values: ['Z'] })) });
    assert.equal(rekeyed.series[0].key, 'Kind');
    assert.equal(chartSelectionIsLive(rekeyed, [{ ...other, seriesKey: 'Vanished' }], new Set(other.ids)), false, 'a missing series is not live');
    assert.equal(chartSelectionIsLive(rekeyed, [other], new Set(other.ids)), true, 'the same series still carrying every id stays live');
  });
});

describe('chart selection reconciliation cost (#4833)', () => {
  it('reconciles a selected bucket of tens of thousands of ids in linear time on both the same-data and changed-data paths', () => {
    const size = 60_000;
    const before = aggregate(SPEC, dataset(size, 'rev-1'));
    const identity = chartBucketIdentity(before, { seriesIndex: 0, dataIndex: 0 })!;
    assert.ok(identity.ids.length > 30_000, 'the clicked bucket is large enough that a per-id Set rebuild would take minutes');
    const selected = new Set(identity.ids);

    const started = performance.now();
    // Same data: every selected id is still in the bucket.
    assert.equal(chartSelectionIsLive(before, [identity], selected), true);
    // Changed data, same membership: the strict comparison must not rebuild the bucket set per id either.
    assert.equal(chartSelectionIsLive(aggregate(SPEC, dataset(size, 'rev-2')), [identity], selected), true);
    // The folded path: the bucket vanished by name and its ids must be found under Other.
    const folded = aggregate({ ...SPEC, topN: 1, sort: 'label' }, dataset(size, 'rev-3'));
    const otherIdentity = chartBucketIdentity(folded, { seriesIndex: 0, dataIndex: 1 })!;
    assert.equal(otherIdentity.isOther, true);
    assert.equal(chartSelectionIsLive(aggregate({ ...SPEC, topN: 1, sort: 'label' }, dataset(size, 'rev-4')), [otherIdentity], new Set(otherIdentity.ids)), true);
    const elapsed = performance.now() - started;
    // Linear work over 60k ids is milliseconds; the quadratic version that
    // rebuilt `new Set(bucket.ids)` inside a per-id predicate is O(n²) ≈ 10⁹
    // insertions here and does not finish inside the test timeout.
    assert.ok(elapsed < 2_000, `reconciliation took ${elapsed.toFixed(0)} ms`);
  });
});
