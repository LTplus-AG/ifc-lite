/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model swap must invalidate the ids already in the transcript (#2471).
 *
 * The playground is single-model by construction, so the unqualified-identity
 * defect #2471 was filed for is not reachable. This is the half that is: two
 * files in one session, and an agent holding `expressId`s from the first.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { modelSwapNotice, type SwapModelRef } from './playground-model-swap.js';

const A: SwapModelRef = { loadId: 1, name: 'tower.ifc' };
const B: SwapModelRef = { loadId: 2, name: 'annex.ifc' };

describe('modelSwapNotice', () => {
  it('warns when a different model is loaded under an existing transcript', () => {
    const notice = modelSwapNotice(A, B, 4);
    assert.ok(notice, 'a swap with history must be announced');
    assert.match(notice.text, /annex\.ifc/, 'names the model now loaded');
    assert.match(notice.text, /expressId/, 'names what is invalidated');
    // The agent reads the transcript as conversation; a notice it cannot see
    // as input would never reach it.
    assert.equal(notice.role, 'user');
  });

  it('does not claim GlobalIds are invalid — they can survive a revision', () => {
    const notice = modelSwapNotice(A, B, 4);
    assert.ok(notice);
    assert.match(
      notice.text,
      /GlobalIds may survive/,
      'two revisions of one project is the likeliest two-file session; ' +
        'telling the agent every GlobalId is dead makes it re-query valid ones',
    );
  });

  it('warns after unload-then-load, which is a button in the same toolbar', () => {
    // Load A, close (lastLoaded must NOT be cleared), then load B. If the
    // caller reset its ref on close this reads as a first load and the whole
    // guard is bypassed.
    assert.equal(modelSwapNotice(A, null, 5), null, 'closing says nothing yet');
    const afterReload = modelSwapNotice(A, B, 5);
    assert.ok(afterReload, 'the deferred warning must arrive on the next load');
  });

  it('warns when the same FILENAME is re-dropped, because ids are filename slugs', () => {
    // A revised `tower.ifc` keeps the model id. Every expressId may have
    // moved, so identity is the load, not the name.
    const revised: SwapModelRef = { loadId: 7, name: 'tower.ifc' };
    assert.ok(modelSwapNotice(A, revised, 3));
  });

  it('says nothing on the first load — there is no earlier id to invalidate', () => {
    assert.equal(modelSwapNotice(null, A, 0), null);
    assert.equal(modelSwapNotice(null, A, 3), null);
  });

  it('says nothing when the same load re-renders', () => {
    assert.equal(modelSwapNotice(A, { ...A }, 5), null);
  });

  it('says nothing when the transcript is empty', () => {
    assert.equal(modelSwapNotice(A, B, 0), null);
  });

  it('gives every load a distinct key, so A→B→A→B does not collide', () => {
    // The transcript renders `<li key={m.id}>`; two messages sharing an id
    // are a React key collision, not just a cosmetic repeat.
    const ids = [
      modelSwapNotice(A, B, 2),
      modelSwapNotice(B, { loadId: 3, name: 'tower.ifc' }, 3),
      modelSwapNotice({ loadId: 3, name: 'tower.ifc' }, { loadId: 4, name: 'annex.ifc' }, 4),
    ].map((n) => n?.id);
    assert.equal(new Set(ids).size, 3, `keys collided: ${ids.join(', ')}`);
  });
});
