/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IDS-030: the Studio's one write path gates every batch and commits it as one undo step. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { undo } from '@ifc-lite/ids-authoring';
import { wallFixture } from '@/test/ids-studio-fixture';
import { dispatchStudioOps } from './session';
import { setFieldOp, setSpecTextOp } from './ops';

describe('dispatchStudioOps (IDS-030)', () => {
  it('refuses a batch the gate rejects and leaves the state untouched', async () => {
    const { contexts, state, propertyId } = await wallFixture();
    const result = dispatchStudioOps(state, [setFieldOp(propertyId, 'property.baseName', { kind: 'equals', value: 'FireRatng' })], contexts.gate);
    assert.equal(result.ok, false);
    assert.equal(result.state, state, 'a refused batch returns the very same state');
    if (!result.ok) {
      assert.equal(result.issues[0].code, 'GATE-PROP-001');
      assert.ok(result.issues[0].candidates.some((c) => c.value === 'FireRating'), 'the gate ranks the intended name');
    }
  });

  it('commits an accepted batch as ONE history entry that undo reverts exactly', async () => {
    const { contexts, state, specId, propertyId } = await wallFixture();
    const ops = [setSpecTextOp(specId, 'name', 'Walls'), setFieldOp(propertyId, 'property.value', { kind: 'oneOf', values: ['EI60', 'EI90'] })];
    const result = dispatchStudioOps(state, ops, contexts.gate, { label: 'edit' });
    assert.equal(result.ok, true);
    assert.equal(result.state.history.past.length, 1);
    assert.equal(result.state.doc.ids.specifications[0].name, 'Walls');
    const facet = result.state.doc.ids.specifications[0].requirements[0].facet;
    assert.deepEqual(facet.type === 'property' ? facet.value : undefined, { type: 'enumeration', values: ['EI60', 'EI90'] });
    assert.ok(result.ok && result.touched.has(propertyId));
    assert.deepEqual(undo(result.state).doc, state.doc, 'one undo restores the document deep-equal');
  });

  it('treats an empty batch as a no-op success', async () => {
    const { contexts, state } = await wallFixture();
    const result = dispatchStudioOps(state, [], contexts.gate);
    assert.equal(result.ok, true);
    assert.equal(result.state, state);
  });
});
