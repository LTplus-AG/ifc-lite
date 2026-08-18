/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/2719: a recipient's `maxExpressId` was
 * captured on the FIRST reconstruct and never moved again.
 *
 * The chain, each link verified against the code: `collabSlice` computed the
 * bound only inside `if (!modelCreated)`; the re-derive branch called only
 * `setIfcDataStore`, which writes `{...model, ifcDataStore}` and leaves the
 * bound alone; the IFCX re-derive re-allocates dense ids from 1
 * (`entity-extractor.ts`), so a peer's newly created entity lands above the
 * frozen bound; and `globalId.ts` gates resolution on
 * `localExpressId <= model.maxExpressId`. Net effect: everything a peer added
 * after the joiner's first reconstruct silently stopped resolving.
 *
 * The bound's movement rule is the part worth pinning, because it is wrong in
 * BOTH directions: frozen loses new entities, and tracking the count exactly
 * would break ids already handed out when a peer deletes something.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { highestExpressId, raisedMaxExpressId } from './collabSlice.js';

const idMap = (...ids: number[]): Map<number, string> =>
  new Map(ids.map((id) => [id, `/GUID${id}`]));

describe('highestExpressId', () => {
  it('is the largest id present, not the count', () => {
    // Sparse ids are the realistic case after edits, and a count would report 3.
    assert.equal(highestExpressId(idMap(4, 91, 17)), 91);
  });

  it('is 0 for an absent or empty map', () => {
    assert.equal(highestExpressId(undefined), 0);
    assert.equal(highestExpressId(new Map()), 0);
  });
});

describe('raisedMaxExpressId: the bound only ever goes up', () => {
  it('raises when a peer added an entity above the frozen bound', () => {
    // The defect in one line: without this the joiner keeps 12 and entity 13
    // resolves to nothing.
    assert.equal(raisedMaxExpressId(12, idMap(1, 7, 13)), 13);
  });

  it('does not move when the re-derive stayed within the bound', () => {
    // null means "no write", which matters: an unconditional updateModel would
    // churn the model record on every peer edit.
    assert.equal(raisedMaxExpressId(20, idMap(1, 7, 13)), null);
  });

  it('does not move when the highest id is exactly the bound', () => {
    // The boundary the gate uses is `<=`, so an id equal to the bound already
    // resolves and needs no raise.
    assert.equal(raisedMaxExpressId(13, idMap(13)), null);
  });

  it('does NOT lower the bound when a peer deleted the highest entity', () => {
    // Tracking the current maximum exactly would be the mirror-image defect:
    // ids already handed out to selection or annotations must keep resolving.
    assert.equal(raisedMaxExpressId(99, idMap(1, 2, 3)), null);
  });

  it('raises from a fresh model that has seen nothing yet', () => {
    assert.equal(raisedMaxExpressId(0, idMap(5)), 5);
  });

  it('stays put for an empty re-derive rather than collapsing to 0', () => {
    assert.equal(raisedMaxExpressId(42, undefined), null);
    assert.equal(raisedMaxExpressId(42, new Map()), null);
  });
});
