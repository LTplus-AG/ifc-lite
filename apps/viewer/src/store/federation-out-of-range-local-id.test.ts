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
import { MutablePropertyView } from '@ifc-lite/mutations';
import { federationRegistry } from '@ifc-lite/renderer';
import { fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore } from './index.js';
import { fromGlobalIdFromModels } from './globalId.js';
import { resolveEntityRef } from './resolveEntityRef.js';

const initial = useViewerStore.getState();

/** Register a model with `maxExpressId` 100 and put it in the store; returns its offset. */
function loadModel(id: string): number {
  const { registerModelOffset, addModel } = useViewerStore.getState();
  const offset = registerModelOffset(id, 100);
  addModel({ ...fixtureModel(id, { idOffset: offset }), maxExpressId: 100 });
  return offset;
}

/** Register 'earlier' then 'later', and keep only 'later' loaded, as after removing the first model. */
function laterModelAlone(): number {
  useViewerStore.getState().registerModelOffset('earlier', 2_000_000);
  const offset = loadModel('later');
  federationRegistry.unregisterModel('earlier');
  return offset;
}

/** The ref a resolver gave must survive the next toGlobalId. */
function assertPublishable(ref: { modelId: string; expressId: number }): void {
  assert.doesNotThrow(() => useViewerStore.getState().toGlobalId(ref.modelId, ref.expressId), JSON.stringify(ref));
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
    // Publish overlay ownership above the parse range before resolving it.
    federationRegistry.publishOverlayRange('later', 101, 150);
    assert.deepEqual(fromGlobalIdFromModels(state.models, offset + 150), { modelId: 'later', expressId: 150 });
  });

  it('resolveEntityRef does not pin an unowned id on the only model behind a removed one', () => {
    laterModelAlone();
    // On main both became { later, id }: -2024174 made toGlobalId throw the #11527 message,
    // and 5 (inside later's LOCAL range) silently targeted later's entity at offset + 5.
    for (const globalId of [-2_024_174, 5]) {
      const ref = resolveEntityRef(globalId);
      assert.deepEqual(ref, { modelId: 'legacy', expressId: globalId });
      assertPublishable(ref);
    }
  });

  it('an id the offset-0 model owns still resolves to it', () => {
    assert.equal(loadModel('only'), 0);
    assert.deepEqual(resolveEntityRef(7), { modelId: 'only', expressId: 7 });
  });
});

describe('positive renderer ID ownership (#11607)', () => {
  beforeEach(() => federationRegistry.clear());
  afterEach(() => { useViewerStore.setState(initial, true); federationRegistry.clear(); });

  it('does not attribute a removed model’s pick to the remaining offset-zero model', () => {
    loadModel('primary');
    const removedId = loadModel('removed') + 7;
    useViewerStore.getState().removeModel('removed');

    const state = useViewerStore.getState();
    assert.equal(state.models.size, 1);
    assert.equal(fromGlobalIdFromModels(state.models, removedId), undefined);
    const ref = resolveEntityRef(removedId);
    assert.deepEqual(ref, { modelId: 'legacy', expressId: removedId });
    assert.equal(state.toGlobalId(ref.modelId, ref.expressId), removedId);
  });

  it('uses the published range of a streaming primary with a zero parse max', () => {
    const offset = federationRegistry.reserveModel('stream', 100);
    useViewerStore.getState().addModel({ ...fixtureModel('stream', { idOffset: offset }), maxExpressId: 0 });
    federationRegistry.publishRange('stream', 1, 25);

    const state = useViewerStore.getState();
    const ref = { modelId: 'stream', expressId: 25 };
    assert.deepEqual(resolveEntityRef(25), ref);
    assert.deepEqual(fromGlobalIdFromModels(state.models, 25), ref);
    assertPublishable(ref);
    assert.deepEqual(resolveEntityRef(26), { modelId: 'legacy', expressId: 26 });
    assert.equal(fromGlobalIdFromModels(state.models, 26), undefined);
  });

  it('resolves an authored entity before the registry publishes its ID', () => {
    loadModel('editable');
    loadModel('peer');
    const view = new MutablePropertyView(null, 'editable');
    view.setExpressIdWatermark(100);
    const { expressId } = view.createEntity('IfcWall', []);
    const mutationViews = new Map([['editable', view]]);
    useViewerStore.setState({ mutationViews });

    const state = useViewerStore.getState();
    const ref = { modelId: 'editable', expressId };
    assert.equal(federationRegistry.fromGlobalId(expressId), null);
    assert.deepEqual(resolveEntityRef(expressId), ref);
    assert.deepEqual(fromGlobalIdFromModels(state.models, expressId, (id) => mutationViews.get(id)), ref);
    assertPublishable(ref);
  });
});
