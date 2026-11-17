/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The shared match rule (search-match.ts) against hand-written expectations of
// tier-1's established behaviour. tier-parity.test.ts only proves the two tiers
// agree; this pins WHAT they agree on, so a defect in the shared rule (a score
// constant, the sweep boundary, the token fallback) fails here even though both
// tiers would be wrong the same way.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { StringTable, EntityTableBuilder } from '@ifc-lite/data';
import { runTier0Scan } from './tier0-scan.js';
import { buildTier1Index, queryTier1Indexes } from './tier1-index.js';
import { SCORE, prepareSearchQuery } from './search-match.js';

const ROWS: [number, string, string, string, string, string][] = [
  // id, type, name, description, objectType, globalId
  [1, 'IfcSpace', 'Room', '', '', ''],
  [2, 'IfcSpace', 'Room A1', '', '', ''],
  [3, 'IfcSpace', 'Bathroom a', '', '', ''],
  [4, 'IfcWall', 'Basement Wall', 'load bearing', '', ''],
  [5, 'IfcWall', 'Exterior Wall', '', 'Basic Wall: 300mm', '2O2Fr$t4X7Zf8NOew3FLOH'],
  [6, 'IfcDoor', 'Stair/Core B', '', '', ''],
];

function store(): IfcDataStore {
  const strings = new StringTable();
  const b = new EntityTableBuilder(ROWS.length, strings);
  for (const [id, type, name, d, o, g] of ROWS) b.add(id, type, g, name, d, o, true);
  return { entities: b.build(), strings } as unknown as IfcDataStore;
}

const EXPECTED: Record<string, string[]> = {
  // Substring ladder on candidates (each a token prefix too).
  'room': ['1:500:name', '2:100:name'],
  'basement': ['4:100:name'],
  'Stair/Core': ['6:100:name'],
  // Token fallback: every query token prefixes a row token, the whole query is no substring.
  'wall basement': ['4:70:name'],
  'Room A': ['2:100:name', '1:70:name'],
  // A 3+ letter mid-word substring is no candidate and is never swept.
  'oom': [],
  'asement': [],
  // A < 3 letter needle with no candidate is swept by substring.
  'oo': ['1:40:name', '2:40:name', '3:40:name'],
  // A separator needle with no candidate (both words are one letter) is swept by substring.
  'm a': ['2:40:name', '3:40:name'],
  // Type, object type and description fields.
  'IfcWall': ['4:80:type', '5:80:type'],
  'ifcwa': ['4:60:type', '5:60:type'],
  'bearing': ['4:10:description'],
  '300mm': ['5:20:objectType'],
  // An exact GlobalId outranks everything.
  '2O2Fr$t4X7Zf8NOew3FLOH': ['5:1000:globalId'],
};

describe('the shared search rule', () => {
  it('keeps tier-1\'s score ladder', () => {
    assert.deepEqual({ ...SCORE }, { GUID_EXACT: 1000, NAME_EXACT: 500, NAME_PREFIX: 100, TYPE_EXACT: 80, TOKEN_MATCH: 70, TYPE_PREFIX: 60,
      NAME_SUBSTR: 40, OBJECTTYPE_SUBSTR: 20, DESCRIPTION_SUBSTR: 10 });
  });

  it('sweeps only needles under 3 characters or with a separator', () => {
    assert.deepEqual(['oo', 'oom', 'm a', 'a-b', 'abc', 'x'].map((q) => prepareSearchQuery(q).sweep), [true, false, true, true, false, true]);
  });

  it('returns the expected rows, scores and fields from both tiers', async () => {
    const s = store();
    const index = await buildTier1Index('m', s);
    for (const [q, want] of Object.entries(EXPECTED)) {
      const rows = (rs: { expressId: number; score: number; matchField: string }[]) => rs.map((r) => `${r.expressId}:${r.score}:${r.matchField}`);
      assert.deepEqual(rows(queryTier1Indexes([index], q, { limit: 100 })), want, `tier-1 ${JSON.stringify(q)}`);
      assert.deepEqual(rows(runTier0Scan([{ id: 'm', ifcDataStore: s }], q, { limit: 100 })), want, `Tier-0 ${JSON.stringify(q)}`);
    }
  });
});
