/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #11527: production reported "[FederationRegistry] Local ID -2024174 is not
 * published for model <id>". A renderer id outside every loaded model's range
 * was turned into an out-of-range local id by a fallback resolver, and the
 * next `toGlobalId` threw. The case: one model left loaded at a non-zero
 * offset (an earlier model was removed; offset space is never reclaimed).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { federationRegistry } from '@ifc-lite/renderer';
import { fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore } from './index.js';
import { fromGlobalIdFromModels } from './globalId.js';
import { resolveEntityRef } from './resolveEntityRef.js';

const initial = useViewerStore.getState();

/** Register 'earlier' then 'later', and keep only 'later' loaded, as after removing the first model. */
function laterModelAlone(): number {
  const { registerModelOffset, addModel } = useViewerStore.getState();
  registerModelOffset('earlier', 2_000_000);
  const offset = registerModelOffset('later', 100);
  addModel({ ...fixtureModel('later', { idOffset: offset }), maxExpressId: 100 });
  federationRegistry.unregisterModel('earlier');
  return offset;
}

describe('fallback resolvers never hand out a local id the model does not own (#11527)', () => {
  beforeEach(() => federationRegistry.clear());
  afterEach(() => { useViewerStore.setState(initial, true); federationRegistry.clear(); });

  it('an id below the only model\'s offset resolves to no model, not a negative local id', () => {
    const offset = laterModelAlone();
    assert.ok(offset > 2_000_000, 'the later model sits behind the removed one');
    const state = useViewerStore.getState();
    assert.equal(state.models.size, 1);
    const ref = fromGlobalIdFromModels(state.models, 5);
    assert.equal(ref, undefined, `got ${JSON.stringify(ref)}`);
    // An overlay id above the parse range is still rescued for the single model.
    assert.deepEqual(fromGlobalIdFromModels(state.models, offset + 150), { modelId: 'later', expressId: 150 });
  });

  it('resolveEntityRef never gives the only model an id it does not own', () => {
    laterModelAlone();
    // 5 is inside the later model's LOCAL range, but as a renderer id it belongs to no loaded model.
    for (const globalId of [5, -2_024_174]) {
      const ref = resolveEntityRef(globalId);
      assert.equal(ref.modelId, 'legacy', `resolveEntityRef(${globalId}) gave ${JSON.stringify(ref)}`);
      assert.doesNotThrow(() => useViewerStore.getState().toGlobalId(ref.modelId, ref.expressId));
    }
  });

  it('a stale id past every range does not become the first model\'s local id', () => {
    const { registerModelOffset, addModel } = useViewerStore.getState();
    const a = registerModelOffset('a', 100);
    const b = registerModelOffset('b', 100);
    addModel({ ...fixtureModel('a', { idOffset: a }), maxExpressId: 100 });
    addModel({ ...fixtureModel('b', { idOffset: b }), maxExpressId: 100 });
    const ref = resolveEntityRef(b + 5_000_000);
    assert.equal(ref.modelId, 'legacy', JSON.stringify(ref));
    assert.doesNotThrow(() => useViewerStore.getState().toGlobalId(ref.modelId, ref.expressId));
  });

  it('an id the offset-0 model owns still resolves to it', () => {
    const { registerModelOffset, addModel } = useViewerStore.getState();
    const offset = registerModelOffset('only', 100);
    addModel({ ...fixtureModel('only', { idOffset: offset }), maxExpressId: 100 });
    assert.equal(offset, 0);
    assert.deepEqual(resolveEntityRef(7), { modelId: 'only', expressId: 7 });
  });
});
