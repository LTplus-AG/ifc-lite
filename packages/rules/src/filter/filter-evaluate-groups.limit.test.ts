/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A shrinking per-group `limit` can underfill a union (#4987 review): if a
 * later group's first N matches (in iteration order) all duplicate ones an
 * earlier group already returned, capping that group's OWN evaluator call
 * at the (small) remaining budget stops it before its later, genuinely
 * unique matches are ever reached. Fixed by handing every group the FULL
 * limit rather than `limit - out.length`, in both `evaluateFilterGroups`
 * (sync) and `evaluateFilterGroupsFederated` (async) — see
 * `filter-evaluate-groups.ts`.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { StringTable, EntityTableBuilder } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterGroups, evaluateFilterGroupsFederated } from './filter-evaluate-groups.js';
import { Rule } from './filter-rules.js';

interface Row { expressId: number; globalId: string }

function buildStore(rows: Row[]): IfcDataStore {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(rows.length, strings);
  for (const r of rows) builder.add(r.expressId, 'IFCWALL', r.globalId, `Wall-${r.expressId}`, '', '', false, false);
  const entities = builder.build();
  const byType = new Map<string, number[]>([['IFCWALL', rows.map((r) => r.expressId)]]);
  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: rows.length,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: { ranges: new Uint32Array(0), index: new Map() }, byType },
    strings,
    entities,
    properties: { count: 0 },
    quantities: { count: 0 },
    relationships: { count: 0 },
  } as unknown as IfcDataStore;
}

// 6 entities in ascending expressId (= iteration) order. Group A matches the
// first 4 by GlobalId; group B matches all 6 — its first 4 (in iteration
// order) duplicate group A's, and G5/G6 are its only genuinely unique
// contribution.
const GIDS = ['1abcdefghijklmnopqrstu', '2abcdefghijklmnopqrstu', '3abcdefghijklmnopqrstu',
  '4abcdefghijklmnopqrstu', '5abcdefghijklmnopqrstu', '6abcdefghijklmnopqrstu'];
const rows: Row[] = GIDS.map((globalId, i) => ({ expressId: i + 1, globalId }));

const groupA = Rule.globalId(GIDS.slice(0, 4));
const groupB = Rule.globalId(GIDS.slice(0, 6));

describe('evaluateFilterGroups — a shrinking per-group limit does not underfill the union', () => {
  it('sync: fills to the requested limit even when the second group\'s early matches are all duplicates', () => {
    const store = buildStore(rows);
    const out = evaluateFilterGroups('m1', store, [
      { rules: [groupA], combinator: 'AND' },
      { rules: [groupB], combinator: 'AND' },
    ], { limit: 5 });
    // Group A alone gives 4; the old (buggy) code capped group B's own call
    // at `limit - 4 = 1`, which only re-found G1 (a duplicate) and never
    // reached G5 — the union stayed at 4 instead of filling to 5.
    assert.strictEqual(out.length, 5);
    assert.deepStrictEqual(out.map((r) => r.expressId).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  it('sync: an unbounded run still returns every unique element from both groups', () => {
    const store = buildStore(rows);
    const out = evaluateFilterGroups('m1', store, [
      { rules: [groupA], combinator: 'AND' },
      { rules: [groupB], combinator: 'AND' },
    ], { limit: 1000 });
    assert.strictEqual(out.length, 6);
  });

  it('federated: same fill-to-limit fix applies to the async entry', async () => {
    const store = buildStore(rows);
    const out = await evaluateFilterGroupsFederated(
      [{ id: 'm1', store }],
      [
        { rules: [groupA], combinator: 'AND' },
        { rules: [groupB], combinator: 'AND' },
      ],
      { limit: 5 },
    );
    assert.strictEqual(out.length, 5);
  });
});
