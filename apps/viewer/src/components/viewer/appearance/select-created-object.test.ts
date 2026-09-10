/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { selectCreatedAppearanceObject } from './select-created-object';
afterEach(() => useViewerStore.getState().clearEntitySelection());
test('created appearance object replaces previous federated multi-selection across all selection representations (#4380)', () => {
  const state = useViewerStore.getState();
  state.setSelectedEntityIds([100,200]);
  state.addEntityToSelection({modelId:'first',expressId:10});
  state.addEntityToSelection({modelId:'second',expressId:20});
  selectCreatedAppearanceObject('destination',{globalId:300,expressId:65});
  const after = useViewerStore.getState();
  assert.equal(after.selectedEntityId,300); assert.deepEqual([...after.selectedEntityIds],[300]);
  assert.deepEqual(after.selectedEntity,{modelId:'destination',expressId:65});
  assert.equal(after.selectedEntitiesSet.size,1);
  assert.equal(after.isEntitySelected({modelId:'destination',expressId:65}),true);
  assert.equal(after.isEntitySelected({modelId:'first',expressId:10}),false);
  assert.equal(after.isEntitySelected({modelId:'second',expressId:20}),false);
  assert.deepEqual(after.selectedEntities,[]);
});
