/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
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

  it('keeps the legacy store fallback while a registered model is hydrating', () => {
    const legacyStore = {
      entities: { getGlobalId: (expressId: number) => `LEGACY-${expressId}` },
    } as unknown as IfcDataStore;
    useViewerStore.setState({
      models: new Map([['primary', {
        id: 'primary', idOffset: 0, maxExpressId: 100, ifcDataStore: null,
      }]]) as unknown as ViewerState['models'],
      ifcDataStore: legacyStore,
    });

    assert.equal(resolveGlobalId(7), 'LEGACY-7');
    assert.equal(
      resolveEntityRefGlobalIdFromState(useViewerStore.getState(), { modelId: 'primary', expressId: 7 }),
      null,
      'exact model refs must not borrow a different model’s legacy store',
    );
  });

  it('does not borrow a legacy GUID when the resolved federated store is hydrated', () => {
    const storeWithoutGuid = {
      entities: { getGlobalId: () => undefined },
    } as unknown as IfcDataStore;
    const legacyStore = {
      entities: { getGlobalId: (expressId: number) => `WRONG-${expressId}` },
    } as unknown as IfcDataStore;
    useViewerStore.setState({
      models: new Map([['federated', {
        id: 'federated', idOffset: 0, maxExpressId: 100, ifcDataStore: storeWithoutGuid,
      }]]) as unknown as ViewerState['models'],
      ifcDataStore: legacyStore,
    });

    assert.equal(resolveGlobalId(7), null,
      'a missing GUID in a hydrated model must not resolve to another model’s entity');
  });

  it('resolves an edited GlobalId before the immutable entity table (#4921)', () => {
    const baseStore = {
      entities: { getGlobalId: () => 'ORIGINAL-GUID' },
    } as unknown as IfcDataStore;
    const overlay = new MutablePropertyView(null, 'edited');
    overlay.setAttribute(7, 'GlobalId', 'EDITED-GUID', 'ORIGINAL-GUID');
    useViewerStore.setState({
      models: new Map([['edited', {
        id: 'edited', idOffset: 0, maxExpressId: 100, ifcDataStore: baseStore,
      }]]) as unknown as ViewerState['models'],
      mutationViews: new Map([['edited', overlay]]),
    });

    assert.equal(
      resolveEntityRefGlobalIdFromState(useViewerStore.getState(), { modelId: 'edited', expressId: 7 }),
      'EDITED-GUID',
    );
  });
});
