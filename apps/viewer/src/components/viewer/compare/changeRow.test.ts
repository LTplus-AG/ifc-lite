/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ContentMatch, ContentMatchKind, DiffCounts } from '@ifc-lite/diff';
import { contentMatchRows, hasReportableChanges } from './changeRow.js';
import type { CompareRef } from '@/lib/compare/buildFingerprints';

const fp = (modelId: string, globalId: number, ifcType = 'IfcWall') => ({
  key: `k${globalId}`,
  ifcType,
  dataHash: 'd',
  ref: { modelId, localId: globalId, globalId },
});

function match(
  kind: ContentMatchKind,
  base: number[],
  head: number[],
  distance?: number,
): ContentMatch<CompareRef> {
  return {
    kind,
    dataHash: 'd',
    base: base.map((id) => fp('a', id)),
    head: head.map((id) => fp('b', id)),
    ...(distance === undefined ? {} : { distance }),
  };
}

const nameOf = (ref: CompareRef): string => `name-${ref.globalId}`;

describe('contentMatchRows (#1891)', () => {
  it('returns nothing when the content pass did not run', () => {
    assert.deepStrictEqual(contentMatchRows(undefined, nameOf), []);
  });

  it('builds a retiring row that selects only the surviving head copies', () => {
    // The base copies are hidden by the overlay, so selecting them would frame
    // the camera on geometry the user cannot see.
    const [row] = contentMatchRows([match('renamed', [1, 2], [1001, 1002])], nameOf);
    assert.strictEqual(row.retiring, true);
    assert.deepStrictEqual(row.refs.map((r) => r.globalId), [1001, 1002]);
    assert.deepStrictEqual([row.baseCount, row.headCount], [2, 2]);
    assert.strictEqual(row.name, 'name-1001');
    assert.strictEqual(row.ifcType, 'IfcWall');
  });

  it('builds a review row that selects every candidate on BOTH sides', () => {
    const [row] = contentMatchRows([match('ambiguous', [1, 2], [1001])], nameOf);
    assert.strictEqual(row.retiring, false);
    assert.deepStrictEqual(row.refs.map((r) => r.globalId), [1, 2, 1001]);
  });

  it('carries the engine distance through', () => {
    const [row] = contentMatchRows([match('moved', [1], [1001], 1.75)], nameOf);
    assert.strictEqual(row.distance, 1.75);
  });

  it('leaves the distance undefined when the engine could not measure one', () => {
    // Without an `aabb` on both sides the engine reports a bare `moved`; the
    // row must not invent a 0 m displacement that reads as "did not move".
    const [row] = contentMatchRows([match('moved', [1], [1001])], nameOf);
    assert.strictEqual(row.distance, undefined);
  });

  it('gives every row a key that cannot collide with a DiffEntry key', () => {
    // The panel stores the focused row in the single `compareSelectedKey`
    // channel that also feeds `diff.byKey` lookups, so a collision would show
    // the wrong element's detail.
    const rows = contentMatchRows(
      [match('renamed', [1], [1001]), match('ambiguous', [2], [1002])],
      nameOf,
    );
    assert.deepStrictEqual(rows.map((r) => r.key), ['match:0', 'match:1']);
    for (const row of rows) assert.ok(row.key.startsWith('match:'));
  });

  it('skips a match record that carries no entities at all', () => {
    assert.deepStrictEqual(contentMatchRows([match('renamed', [], [])], nameOf), []);
  });
});

describe('hasReportableChanges (#1891 review)', () => {
  const counts = (added: number, modified: number, deleted: number): DiffCounts => ({
    added,
    modified,
    deleted,
    unchanged: 500,
  });

  it('is false when there is neither an entry nor a match row', () => {
    // Drives BOTH the panel's "Download report" bar and the results list's "the
    // models match" empty state, which are exact negations - so this false case
    // is the one that must show the empty state and hide the export. The 500
    // `unchanged` elements must not count: they are never listed or exported.
    assert.strictEqual(hasReportableChanges(counts(0, 0, 0), []), false);
  });

  it('counts a comparison whose entries are all zero but has matches', () => {
    // The headline #1891 case: a from-scratch re-export where the pass retired
    // every added/deleted entry. `counts` alone reads as "the models match",
    // which is exactly wrong - there is a full Matched section to list and a
    // full CSV to export.
    const [row] = contentMatchRows([match('renamed', [1], [1001])], nameOf);
    assert.strictEqual(hasReportableChanges(counts(0, 0, 0), [row]), true);
  });

  it('counts each kind of entry on its own', () => {
    assert.strictEqual(hasReportableChanges(counts(1, 0, 0), []), true);
    assert.strictEqual(hasReportableChanges(counts(0, 1, 0), []), true);
    assert.strictEqual(hasReportableChanges(counts(0, 0, 1), []), true);
  });
});
