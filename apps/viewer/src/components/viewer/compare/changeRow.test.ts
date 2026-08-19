/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ContentMatch, ContentMatchKind, DiffCounts, DiffEntry } from '@ifc-lite/diff';
import {
  bcfTextFromChange,
  changeLabel,
  changedTypeCounts,
  contentMatchRows,
  hasReportableChanges,
  type CompareRow,
} from './changeRow.js';
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

const row = (over: Partial<CompareRow> = {}): CompareRow => ({
  key: '2O2Fr$t4X7Zf8NOew3FLOH',
  ifcType: 'IfcWall',
  name: 'W1',
  state: 'modified',
  changeKinds: ['geometry'],
  ref: { modelId: 'a', localId: 1, globalId: 1 },
  ...over,
});

describe('bcfTextFromChange (#1199)', () => {
  it('omits the GlobalId line for a synthetic `missing:` key without leaving a blank line behind', () => {
    // `missing:` keys are synthesized for a compare row that has no real
    // GlobalId (see CompareRow.key doc) - the line must be dropped, not
    // blanked, so no stray empty line sits where it would have been.
    const { description } = bcfTextFromChange(
      row({ key: 'missing:foo', state: 'deleted', changeKinds: [] }),
      { data: [], geometry: { movedDistance: 1.234, reshaped: false, delta: { x: 0, y: 0, z: 1.234 }, sizeDelta: { x: 0, y: 0, z: 0 } }, dataOnlyGeometric: false },
    );
    assert.strictEqual(description, 'Detected in model comparison: deleted.\nMoved 1.234 m.');
  });

  it('keeps the GlobalId line for a normal key', () => {
    const { description } = bcfTextFromChange(
      row(),
      { data: [], geometry: { movedDistance: 1.234, reshaped: false, delta: { x: 0, y: 0, z: 1.234 }, sizeDelta: { x: 0, y: 0, z: 0 } }, dataOnlyGeometric: false },
    );
    assert.strictEqual(
      description,
      'Detected in model comparison: geometry.\nGlobalId: 2O2Fr$t4X7Zf8NOew3FLOH\nMoved 1.234 m.',
    );
  });

  it('keeps the intentional blank separator before "Data changes:" for a normal key', () => {
    const { description } = bcfTextFromChange(
      row({ changeKinds: ['data'] }),
      {
        data: [{ category: 'property', group: 'Pset_WallCommon', name: 'FireRating', before: 'A', after: 'B', kind: 'changed' }],
        geometry: null,
        dataOnlyGeometric: false,
      },
    );
    assert.strictEqual(
      description,
      'Detected in model comparison: data.\nGlobalId: 2O2Fr$t4X7Zf8NOew3FLOH\n\nData changes:\n- Pset_WallCommon / FireRating: A -> B',
    );
  });

  it('keeps the intentional blank separator AND omits the GlobalId line together for a missing: key', () => {
    // The case a careless single-sentinel fix breaks: the omitted GlobalId
    // line must vanish while the deliberate blank before "Data changes:"
    // survives - exactly one blank line, not zero and not two.
    const { description } = bcfTextFromChange(
      row({ key: 'missing:foo', state: 'deleted', changeKinds: [] }),
      {
        data: [{ category: 'property', group: 'Pset_WallCommon', name: 'FireRating', before: undefined, after: undefined, kind: 'removed' }],
        geometry: null,
        dataOnlyGeometric: false,
      },
    );
    assert.strictEqual(
      description,
      'Detected in model comparison: deleted.\n\nData changes:\n- Pset_WallCommon / FireRating: removed',
    );
  });
});

describe('changedTypeCounts (#1470)', () => {
  const entry = (over: Partial<DiffEntry<CompareRef>>): DiffEntry<CompareRef> => ({
    key: 'k',
    state: 'modified',
    changeKinds: [],
    head: { key: 'k', ifcType: 'IfcWall', dataHash: 'd', ref: { modelId: 'b', localId: 1, globalId: 1 } },
    base: { key: 'k', ifcType: 'IfcWall', dataHash: 'd', ref: { modelId: 'a', localId: 1, globalId: 1 } },
    ...over,
  });

  it('tallies changed entries by type, most-changed first, excluding unchanged', () => {
    const entries = [
      entry({ key: 'w1', head: { key: 'w1', ifcType: 'IfcWall', dataHash: 'd', ref: { modelId: 'b', localId: 1, globalId: 1 } } }),
      entry({ key: 'w2', head: { key: 'w2', ifcType: 'IfcWall', dataHash: 'd', ref: { modelId: 'b', localId: 2, globalId: 2 } } }),
      entry({
        key: 'd1',
        head: { key: 'd1', ifcType: 'IfcDoor', dataHash: 'd', ref: { modelId: 'b', localId: 3, globalId: 3 } },
      }),
      entry({ key: 'u1', state: 'unchanged' }),
    ];
    assert.deepStrictEqual(changedTypeCounts(entries), [
      { type: 'IfcWall', count: 2 },
      { type: 'IfcDoor', count: 1 },
    ]);
  });
});

describe('changeLabel', () => {
  it('reads added/deleted straight off the state', () => {
    assert.strictEqual(changeLabel(row({ state: 'added', changeKinds: [] })), 'added');
    assert.strictEqual(changeLabel(row({ state: 'deleted', changeKinds: [] })), 'deleted');
  });

  it('joins change kinds for a modified row, falling back to "changed" when empty', () => {
    assert.strictEqual(changeLabel(row({ state: 'modified', changeKinds: ['geometry', 'data'] })), 'geometry + data');
    assert.strictEqual(changeLabel(row({ state: 'modified', changeKinds: [] })), 'changed');
  });
});
