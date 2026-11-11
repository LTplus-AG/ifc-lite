/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A search answers from Tier-0 until the tier-1 index is built, then from tier-1.
// Both must return the same rows, scores and order, so results do not change
// under the user at the hand-over (multi-word queries used to differ: tier-1's
// token fallback matched "Room A" and "wall basement", Tier-0 did not).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { runTier0Scan } from './tier0-scan.js';
import { buildTier1Index, queryTier1Indexes } from './tier1-index.js';

const NAMES = ['Room D3', 'Room A1', 'Basement Wall', 'Wall basement-north', 'Slab 9', 'Door 12', 'Window_Frame 2', 'Stair/Core B', 'Room', 'Exterior Wall: 300mm'];
const store = createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0, entities: NAMES.map((name, i) => ({
  expressId: 100 + i, type: ['IfcSpace', 'IfcWall', 'IfcSlab', 'IfcDoor', 'IfcWindow'][i % 5], name, globalId: `g${i}-abcdefghijk`,
})) });

const QUERIES = ['Room A', 'room a', 'wall basement', 'basement wall', 'Room', 'room-a', 'a', 'b2', 'wall', 'exterior 300', 'frame 2', 'stair core', 'IfcWall', 'ifcwa', 'door 1', 'nothing here', '  Slab   9 '];

const rows = (rs: { modelId: string; expressId: number; score: number; matchField: string }[]) => rs.map((r) => `${r.expressId}:${r.score}:${r.matchField}`);

describe('Tier-0 and tier-1 return the same results', () => {
  it('for every query of the corpus, including multi-word and one-letter-word queries', async () => {
    const index = await buildTier1Index('m', store);
    for (const q of QUERIES) {
      assert.deepEqual(rows(runTier0Scan([{ id: 'm', ifcDataStore: store }], q, { limit: 1000 })), rows(queryTier1Indexes([index], q, { limit: 1000 })), `query ${JSON.stringify(q)}`);
    }
  });

  it('matches out-of-order words through the token fallback', () => {
    const ids = runTier0Scan([{ id: 'm', ifcDataStore: store }], 'wall basement', { limit: 1000 }).map((r) => r.expressId);
    assert.ok(ids.includes(102), 'Basement Wall');
  });
});
