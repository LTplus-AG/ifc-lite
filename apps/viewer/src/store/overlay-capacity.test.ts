/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { federationRegistry } from '@ifc-lite/renderer';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type ViewerState } from './index.js';
import { registerOverlayCapacity } from './overlay-capacity.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { readModelEditTarget } from './slices/mutation-modelling-records.js';
import { readOnlyModelEditLease } from '@/lib/actions/model-authoring-read-target';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';

const observers: (() => void)[] = [];
afterEach(() => { for (const stop of observers.splice(0)) stop(); });

it('drains a reentrant view replacement before returning (#10139)', () => {
  federationRegistry.clear();
  try {
    federationRegistry.registerModel('A', 100);
    const model = fixtureModel('A');
    const store = createStore<ViewerState>(() => ({ ...useViewerStore.getState(), ...fixtureModels(model), mutationViews: new Map() }));
    const replacement = new MutablePropertyView(null, 'A');
    let replaced = false;
    store.subscribe((state, previous) => {
      if (!replaced && state.models !== previous.models) {
        replaced = true;
        store.setState({ mutationViews: new Map([['A', replacement]]) });
      }
    });
    observers.push(registerOverlayCapacity(store));
    assert.equal(replaced, true);
    assert.equal(replacement.peekNextExpressId(), 101);
  } finally { federationRegistry.clear(); }
});

it('allocator ticks do not reconfigure other models (#10139)', () => {
  federationRegistry.clear();
  try {
    federationRegistry.registerModel('A', 100);
    federationRegistry.registerModel('B', 100);
    const a = new MutablePropertyView(null, 'A'), b = new MutablePropertyView(null, 'B');
    const store = createStore<ViewerState>(() => ({ ...useViewerStore.getState(),
      ...fixtureModels(fixtureModel('A'), fixtureModel('B')), mutationViews: new Map([['A', a], ['B', b]]) }));
    observers.push(registerOverlayCapacity(store));
    let work = 0;
    const original = b.configureExpressIdAllocator.bind(b);
    b.configureExpressIdAllocator = (...args) => { work++; original(...args); };
    federationRegistry.extendModel('A', 200);
    assert.equal(a.peekNextExpressId(), 201, 'range changes advance only their bound allocator');
    assert.equal(work, 0);
    for (let i = 0; i < 100; i++) a.createEntity('IfcMaterial', ['Unpublished']);
    assert.equal(work, 0);
    federationRegistry.extendModel('A', 200); // no-op
    assert.equal(work, 0);
  } finally { federationRegistry.clear(); }
});

it('cold planner and read lease predict the bound live allocator ID (#10139)', () => {
  federationRegistry.clear();
  try {
    federationRegistry.registerModel('A', 100);
    useViewerStore.setState({ ...fixtureModels(fixtureModel('A')), mutationViews: new Map(), storeEditors: new Map() });
    const cold = useViewerStore.getState();
    const planner = readModelEditTarget(cold, 'A')!;
    const lease = readOnlyModelEditLease(cold, 'A')!;
    const live = getOrCreateMutationView(useViewerStore, 'A')!;
    assert.equal(live.peekNextExpressId(), 101);
    assert.equal(planner.editor.addEntity('IfcMaterial', ['Planned']).expressId, live.peekNextExpressId());
    assert.equal(lease.target.editor.addEntity('IfcMaterial', ['Planned']).expressId, live.peekNextExpressId());
  } finally { federationRegistry.clear(); }
});
