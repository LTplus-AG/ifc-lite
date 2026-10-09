/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StoreEditor } from '@ifc-lite/mutations';
import { IfcCreator } from '@ifc-lite/create';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { BACK_WALL, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore, type ViewerState } from './index.js';
import { resolveEntityRef, resolveEntityRefGlobalIdFromState, resolveGlobalId } from './resolveEntityRef.js';

describe('resolveGlobalId compatibility', () => {
  beforeEach(() => {
    federationRegistry.clear();
    useViewerStore.setState({
      models: new Map(),
      ifcDataStore: null,
      mutationViews: new Map(),
    });
  });

  it('keeps a published streamed federation component with its reserved owner before final metadata installation (#5050)', () => {
    const anchorOffset = federationRegistry.registerModel('anchor', 100);
    const streamedOffset = federationRegistry.reserveModel('landxml-stream', 2);
    federationRegistry.publishRange('landxml-stream', 1, 1);
    useViewerStore.setState({
      models: new Map([['anchor', {
        id: 'anchor', idOffset: anchorOffset, maxExpressId: 100, ifcDataStore: null,
      }]]) as unknown as ViewerState['models'],
    });

    assert.deepEqual(resolveEntityRef(streamedOffset + 1), {
      modelId: 'landxml-stream', expressId: 1,
    }, 'a progressive pick must not fall back to the already-loaded anchor');
    assert.deepEqual(resolveEntityRef(anchorOffset + 7), { modelId: 'anchor', expressId: 7 },
      'the store remains canonical for an installed model');
  });

  it('keeps the legacy store fallback while a registered model is hydrating (#7282)', async () => {
    const { dataStore } = await seedAuthoringSample(), id = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
    const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
    useViewerStore.setState({ models: new Map([['primary', { ...model, id: 'primary', idOffset: 0, maxExpressId: id, ifcDataStore: null }]]), ifcDataStore: dataStore });
    assert.equal(resolveGlobalId(id), BACK_WALL);
    assert.equal(resolveEntityRefGlobalIdFromState(useViewerStore.getState(), { modelId: 'primary', expressId: id }), null,
      'exact model refs must not borrow a different model’s legacy store');
  });

  it('does not borrow a legacy GUID when the resolved federated store is hydrated (#7282)', async () => {
    const { dataStore } = await seedAuthoringSample(), id = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
    const creator = new IfcCreator({ Schema: 'IFC4', LengthUnit: 'METRE', Name: 'Empty federated owner' });
    const hydrated = await parseIfc(new TextEncoder().encode(creator.toIfc().content));
    assert.equal(hydrated.getEntity(id), null);
    const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
    useViewerStore.setState({ models: new Map([['federated', { ...model, id: 'federated', idOffset: 0, maxExpressId: id, ifcDataStore: hydrated }]]),
      mutationViews: new Map(), ifcDataStore: dataStore });
    assert.equal(resolveGlobalId(id), null, 'a missing GUID in a hydrated model must not resolve to another model’s entity');
  });

  it('resolves an edited GlobalId before the immutable entity table (#4921, #7282)', async () => {
    const { dataStore, view } = await seedAuthoringSample(), id = dataStore.entities.getExpressIdByGlobalId(BACK_WALL), current = generateIfcGuid();
    new StoreEditor(dataStore, view).setAttribute(id, 'GlobalId', current);
    const saved = await parseIfc(editedModelBytes(dataStore, view));
    assert.equal(dataStore.entities.getGlobalId(id), BACK_WALL); assert.equal(saved.entities.getGlobalId(id), current);
    assert.equal(resolveEntityRefGlobalIdFromState(useViewerStore.getState(), { modelId: SAMPLE_MODEL, expressId: id }), current);
  });
});
