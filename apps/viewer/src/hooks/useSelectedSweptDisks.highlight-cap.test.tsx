/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { fixtureDataStore, fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import { selectedSweptDiskCache } from '@/lib/analytic/swept-disk-cache.js';
import { useSelectedSweptDisks } from './useSelectedSweptDisks.js';

it('moves a newly highlighted source inside the bounded extraction after select-all (#5783)', async () => {
  const prior = useViewerStore.getState();
  const originalGet = selectedSweptDiskCache.get;
  const requested: number[][] = [];
  const model = fixtureModel('selection', { idOffset: 1_000_000 });
  model.maxExpressId = 300;
  Object.assign(model.ifcDataStore!, { source: { byteLength: 1 } });
  selectedSweptDiskCache.get = async (_model, ids) => {
    requested.push([...ids]);
    return new Map(ids.map((id) => [id, { occurrences: [], diagnostics: [] }]));
  };
  try {
    useViewerStore.setState({ ...fixtureModels(model),
      selectedEntityIds: new Set(Array.from({ length: 300 }, (_, index) => 1_000_001 + index)),
      selectedEntityId: 1_000_001, selectedEntitiesSet: new Set(),
      selectedEntity: { modelId: 'selection', expressId: 1 },
      selectedDirectrixSegment: null });
    const Selection = () => {
      useSelectedSweptDisks(true);
      return null;
    };
    render(<Selection />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.equal(requested[0]?.length, 256);
    assert.equal(requested[0]?.[0], 1);
    assert.ok(!requested[0]?.includes(299), 'the later source starts outside the cap');

    await act(async () => {
      useViewerStore.getState().setSelectedDirectrixSegment({
        modelId: 'selection', expressId: 299, occurrenceIndex: 0, segmentIndex: 0,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(requested.length, 2, 'changing the highlight reruns bounded extraction');
    assert.equal(requested[1]?.length, 256);
    assert.equal(requested[1]?.[0], 299);
    assert.ok(requested[1]?.includes(1), 'the primary source also stays eligible');
  } finally {
    cleanup();
    selectedSweptDiskCache.get = originalGet;
    useViewerStore.setState(prior);
  }
});

it('routes legacy overlay-created products and counts them inside the selected-product cap (#5783)', async () => {
  const prior = useViewerStore.getState();
  const originalGet = selectedSweptDiskCache.get;
  const store = fixtureDataStore([{ expressId: 1, type: 'IfcReinforcingBar' }]);
  Object.assign(store, { source: { byteLength: 1 } });
  const view = new MutablePropertyView(null, '__legacy__');
  view.setExpressIdWatermark(1);
  const createdIds = Array.from({ length: 300 }, () => view.createEntity('IfcReinforcingBar', []).expressId);
  const requested: number[][] = [];
  selectedSweptDiskCache.get = async (_model, ids) => {
    requested.push([...ids]);
    return new Map(ids.map((id) => [id, { occurrences: [], diagnostics: [] }]));
  };
  try {
    useViewerStore.setState({
      models: new Map(), ifcDataStore: store, mutationViews: new Map([['__legacy__', view]]),
      selectedEntityIds: new Set([1, ...createdIds]), selectedEntityId: 1,
      selectedEntitiesSet: new Set(), selectedEntity: { modelId: 'legacy', expressId: 1 },
      selectedDirectrixSegment: null, hiddenEntities: new Set(), lensHiddenIds: new Set(),
      isolatedEntities: null, classFilter: null,
    });
    const snapshots: ReturnType<typeof useSelectedSweptDisks>[] = [];
    const Selection = () => {
      snapshots.push(useSelectedSweptDisks(true));
      return null;
    };
    render(<Selection />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const snapshot = snapshots.at(-1);
    assert.ok(snapshot);
    assert.deepEqual(requested, [[1]], 'only the authored primary product reaches source extraction');
    assert.equal(snapshot.items.length, 256, 'authored and overlay-created products share one cap');
    assert.equal(snapshot.items.filter((item) => item.diagnostics.some((message) =>
      message.includes('created in the overlay'))).length, 255);
    assert.match(snapshot.error ?? '', /45 selected products were omitted/);
  } finally {
    cleanup();
    selectedSweptDiskCache.get = originalGet;
    useViewerStore.setState(prior);
  }
});
