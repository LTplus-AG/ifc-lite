/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The split identity policy's pure parts (#6233; `split-guid.ts`). */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidIfcGuid, uuidToIfcGuid, uuidV5 } from '@ifc-lite/encoding';
import { SPLIT_GLOBALID_NAMESPACE, deriveSplitGlobalId, globalIdTakenIn, keepsFirstPiece, type GlobalIdScope } from './split-guid.js';

const SOURCE = '3wdauVJT5Fx9drrREiDqA$';
const candidate = (source: string, k: number) => uuidToIfcGuid(uuidV5(SPLIT_GLOBALID_NAMESPACE, `${source}/split/${k}`));

describe('deriveSplitGlobalId (#6233)', () => {
  it('is the v5 id of "<source>/split/0" when nothing collides, as a valid IFC GlobalId', () => {
    const id = deriveSplitGlobalId(SOURCE, () => false);
    assert.equal(id, candidate(SOURCE, 0));
    assert.ok(isValidIfcGuid(id));
    assert.equal(deriveSplitGlobalId(SOURCE, () => false), id, 'same inputs, same id');
  });

  it('probes k = 1, 2, … past ids that already exist', () => {
    const taken = new Set([candidate(SOURCE, 0), candidate(SOURCE, 1)]);
    assert.equal(deriveSplitGlobalId(SOURCE, (g) => taken.has(g)), candidate(SOURCE, 2));
  });

  it('depends on the source GlobalId', () => {
    assert.notEqual(deriveSplitGlobalId(SOURCE, () => false), deriveSplitGlobalId('0OfZwWc8j9QP5uX8xPTxDH', () => false));
  });
});

describe('keepsFirstPiece (#6233)', () => {
  it('keeps the larger piece; a tie keeps the piece holding the start', () => {
    assert.equal(keepsFirstPiece(3, 2), true);
    assert.equal(keepsFirstPiece(2, 3), false);
    assert.equal(keepsFirstPiece(2, 2), true);
  });
});

describe('globalIdTakenIn (#6233)', () => {
  it('sees parsed and authored ids across every model', () => {
    const parsed = { getExpressIdByGlobalId: (g: string) => (g === 'parsedInModelA00000000' ? 7 : -1) };
    const isTaken = globalIdTakenIn([
      { dataStore: { entities: parsed } as unknown as GlobalIdScope['dataStore'], view: { getNewEntities: () => [] } },
      { dataStore: null, view: { getNewEntities: () => [{ attributes: ['authoredInModelB000000'] }] } as unknown as GlobalIdScope['view'] },
    ]);
    assert.equal(isTaken('parsedInModelA00000000'), true);
    assert.equal(isTaken('authoredInModelB000000'), true);
    assert.equal(isTaken('free000000000000000000'), false);
  });
});
