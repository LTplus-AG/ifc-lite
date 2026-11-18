/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A search answers from the Tier-0 scan until the model's tier-1 index is built,
// then from tier-1. Both apply one rule (search-match.ts), so they must return
// the same rows, scores, match fields and order for any query: mid-word
// substrings, word permutations, one-letter words, separators, non-ASCII text,
// across several models.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { StringTable, EntityTableBuilder } from '@ifc-lite/data';
import { runTier0Scan, type SearchResult } from './tier0-scan.js';
import { buildTier1Index, queryTier1Indexes, type Tier1Index } from './tier1-index.js';

interface Row { id: number; type: string; name?: string; description?: string; objectType?: string; globalId?: string }

function store(rows: Row[]): IfcDataStore {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(rows.length, strings);
  for (const r of rows) builder.add(r.id, r.type, r.globalId ?? '', r.name ?? '', r.description ?? '', r.objectType ?? '', true);
  return { entities: builder.build(), strings } as unknown as IfcDataStore;
}

const MODEL_A: Row[] = [
  { id: 1, type: 'IfcSpace', name: 'Room D3' }, { id: 2, type: 'IfcSpace', name: 'Room A1' }, { id: 3, type: 'IfcSpace', name: 'Bathroom a' },
  { id: 4, type: 'IfcWall', name: 'Basement Wall' }, { id: 5, type: 'IfcWall', name: 'Wall basement-north', description: 'load bearing' },
  { id: 6, type: 'IfcSlab', name: 'Slab 9' }, { id: 7, type: 'IfcDoor', name: 'Door 12', objectType: 'Double swing' },
  { id: 8, type: 'IfcWindow', name: 'Window_Frame 2' }, { id: 9, type: 'IfcStair', name: 'Stair/Core B' }, { id: 10, type: 'IfcSpace', name: 'Room' },
  { id: 11, type: 'IfcWall', name: 'Exterior Wall: 300mm', globalId: '2O2Fr$t4X7Zf8NOew3FLOH' }, { id: 12, type: 'IfcSpace', name: 'Hallway', description: 'Path to bath' },
  { id: 13, type: 'IfcBuildingElementProxy', name: 'Straße Außenwand' }, { id: 14, type: 'IfcSpace', name: 'Büro Größe ÄÖÜ' },
  { id: 15, type: 'IfcSpace', name: 'İstanbul Ofis' }, { id: 16, type: 'IfcSpace', name: '会议室 二号' }, { id: 17, type: 'IfcSpace', name: '会议 室' },
  { id: 18, type: 'IfcColumn', objectType: 'Steel column HEB 200' }, { id: 19, type: 'IfcBeam', name: 'beam', description: 'Wall bracket' },
  { id: 20, type: 'IfcFurniture', name: 'Chair' },
];
const MODEL_B: Row[] = [
  { id: 1, type: 'IfcWall', name: 'Basement wall east' }, { id: 2, type: 'IfcSpace', name: 'Bathroom' }, { id: 3, type: 'IfcDoor', name: 'room door' },
  { id: 5, type: 'IfcSpace', name: 'Straßenraum' }, { id: 8, type: 'IfcSlab', name: 'roof' }, { id: 9, type: 'IfcWall', name: 'ALL CAPS WALL' },
];

const rows = (rs: SearchResult[]) => rs.map((r) => `${r.modelId}:${r.expressId}:${r.score}:${r.matchField}`);

async function tiers() {
  const a = store(MODEL_A), b = store(MODEL_B);
  const indexes: Tier1Index[] = [await buildTier1Index('a', a), await buildTier1Index('b', b)];
  const models = [{ id: 'a', ifcDataStore: a }, { id: 'b', ifcDataStore: b }];
  return (q: string) => [rows(runTier0Scan(models, q, { limit: 10_000 })), rows(queryTier1Indexes(indexes, q, { limit: 10_000 }))] as const;
}

describe('Tier-0 and tier-1 return the same results', () => {
  it('for a corpus of prefix, mid-word, multi-word, one-letter, separator, GUID and non-ASCII queries', async () => {
    const both = await tiers();
    const QUERIES = ['Room A', 'room a', 'ro', 'oom', 'ath', 'asement', 'all', 'wall basement', 'basement wall', 'Room', 'room-a', 'a', 'b2', 'wall',
      'exterior 300', 'frame 2', 'stair core', 'IfcWall', 'ifcwa', 'door 1', 'nothing here', '  Slab   9 ', 'bath', 'steel', 'heb 2', 'bracket',
      'straße', 'STRASSE', 'außen', 'größe', 'äöü', 'büro', 'istanbul', 'i̇stanbul', '会议', '议室', '室', '二号', 'swing', 'load', '2O2Fr$t4X7Zf8NOew3FLOH', 'w', '9', '1'];
    for (const q of QUERIES) {
      const [t0, t1] = both(q);
      assert.deepEqual(t0, t1, `query ${JSON.stringify(q)}`);
    }
  });

  it('for a few hundred generated queries: substrings and word permutations of the stores\' own text', async () => {
    const both = await tiers();
    let seed = 20261112;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const texts = [...MODEL_A, ...MODEL_B].flatMap((r) => [r.name, r.description, r.objectType]).filter((t): t is string => !!t);
    const queries: string[] = [];
    for (let k = 0; k < 400; k++) {
      const t = texts[Math.floor(rand() * texts.length)];
      if (k % 2 === 0) {
        const start = Math.floor(rand() * t.length), len = 1 + Math.floor(rand() * 8);
        queries.push(t.slice(start, start + len));
      } else {
        const words = t.split(/\s+/).filter(Boolean).sort(() => rand() - 0.5).slice(0, 1 + Math.floor(rand() * 3));
        queries.push(words.map((w) => (rand() < 0.5 ? w.slice(0, 1 + Math.floor(rand() * w.length)) : w)).join(rand() < 0.2 ? '-' : ' '));
      }
    }
    let nonEmpty = 0;
    for (const q of queries) {
      const [t0, t1] = both(q);
      assert.deepEqual(t0, t1, `query ${JSON.stringify(q)}`);
      if (t0.length > 0) nonEmpty++;
    }
    assert.ok(nonEmpty > 300, `most generated queries match something (${nonEmpty}/400)`);
  });

  it('a mid-word substring matches only through the shared rule: no candidate, no sweep for 3+ letters', async () => {
    const both = await tiers();
    assert.deepEqual(both('oom')[0], [], 'tier-1 returns nothing for "oom", so Tier-0 does not either');
    assert.ok(both('oo')[0].length > 0, 'a 2-letter needle with no token prefix ("oo") is swept by substring');
  });
});
