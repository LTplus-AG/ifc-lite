/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { IfcParser } from '@ifc-lite/parser';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { useViewerStore } from './index.js';
import { canMutate, mutationPermission } from './mutation-permission.js';

const first = fixtureModel('first', { entities: [{ expressId: 11, type: 'IfcWall', name: 'A' }] });
const second = fixtureModel('second', { idOffset: 1000, entities: [{ expressId: 22, type: 'IfcWall', name: 'B' }] });
const authoredIfc = new URL('../../public/samples/hello-wall.ifc', import.meta.url);

function seed(twoModels: boolean): void {
  const models = twoModels ? [first, second] : [first];
  useViewerStore.setState({
    ...fixtureModels(...models),
    editEnabled: false,
    collabRole: null,
    mutationViews: new Map(models.map((model) => [model.id, new MutablePropertyView(null, model.id)])),
    undoStacks: new Map(),
    redoStacks: new Map(),
    dirtyModels: new Set(),
    mutationVersion: 0,
  });
}

describe('canonical viewer mutation permission (#5901)', () => {
  beforeEach(() => seed(false));

  for (const twoModels of [false, true]) {
    it(`keeps ${twoModels ? 'federated' : 'single-model'} writes and undo state unchanged until Edit mode is on`, () => {
      seed(twoModels);
      const modelId = twoModels ? second.id : first.id;
      const expressId = twoModels ? 22 : 11;
      const state = useViewerStore.getState();
      assert.deepEqual(mutationPermission(state, modelId), { allowed: false, reason: 'edit-mode' });
      assert.equal(state.setAttribute(modelId, expressId, 'Name', 'Edited'), null);
      assert.equal(useViewerStore.getState().undoStacks.get(modelId)?.length ?? 0, 0);
      assert.equal(useViewerStore.getState().dirtyModels.has(modelId), false);

      useViewerStore.setState({ editEnabled: true });
      assert.equal(canMutate(useViewerStore.getState(), modelId), true);
      assert.ok(useViewerStore.getState().setAttribute(modelId, expressId, 'Name', 'Edited'));
      assert.equal(useViewerStore.getState().undoStacks.get(modelId)?.length, 1);
      assert.equal(useViewerStore.getState().dirtyModels.has(modelId), true);
      if (twoModels) assert.equal(useViewerStore.getState().undoStacks.get(first.id), undefined);
    });
  }

  it('rejects a non-IFC model and a collaboration viewer before creating an undo entry', () => {
    const unavailable = { ...second, ifcDataStore: null };
    useViewerStore.setState({
      ...fixtureModels(first, unavailable),
      editEnabled: true,
      mutationViews: new Map([[unavailable.id, new MutablePropertyView(null, unavailable.id)]]),
      undoStacks: new Map(),
    });
    assert.deepEqual(mutationPermission(useViewerStore.getState(), unavailable.id),
      { allowed: false, reason: 'model-unavailable' });
    assert.equal(useViewerStore.getState().setAttribute(unavailable.id, 22, 'Name', 'Edited'), null);
    useViewerStore.setState({ collabRole: 'viewer' });
    assert.deepEqual(mutationPermission(useViewerStore.getState(), first.id),
      { allowed: false, reason: 'collab-role' });
    assert.equal(useViewerStore.getState().setAttribute(first.id, 11, 'Name', 'Edited'), null);
    assert.equal(useViewerStore.getState().undoStacks.size, 0);
  });

  for (const twoModels of [false, true]) {
    it(`blocks column authoring before overlay creation and authors a column in ${twoModels ? 'federated' : 'single-model'} Edit mode (#5901)`, async () => {
      const bytes = await readFile(authoredIfc);
      const dataStore = await new IfcParser().parseColumnar(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        { disableWorkerScan: true },
      );
      const target = {
        ...fixtureModel('authored', { idOffset: twoModels ? 1000 : 0 }),
        ifcDataStore: dataStore,
        geometryResult: null,
      };
      useViewerStore.setState({
        ...fixtureModels(...(twoModels ? [first, target] : [target])),
        editEnabled: false,
        collabRole: null,
        mutationViews: new Map(),
        undoStacks: new Map(),
        dirtyModels: new Set(),
      });
      const params = { Position: [0, 0, 0] as [number, number, number], Width: 0.3, Depth: 0.3, Height: 3 };
      const denied = useViewerStore.getState().addColumn(target.id, 42, params);
      assert.ok('error' in denied && denied.error.includes('Edit mode'));
      assert.equal(useViewerStore.getState().mutationViews.size, 0);
      assert.equal(useViewerStore.getState().dirtyModels.size, 0);

      useViewerStore.setState({ editEnabled: true });
      assert.ok(getOrCreateMutationView(useViewerStore, target.id));
      const created = useViewerStore.getState().addColumn(target.id, 42, params);
      assert.ok('expressId' in created, 'the authored IFC storey accepts a real column');
      assert.equal(useViewerStore.getState().dirtyModels.has(target.id), true);
      assert.ok((useViewerStore.getState().undoStacks.get(target.id)?.length ?? 0) > 0);
      if (twoModels) assert.equal(useViewerStore.getState().dirtyModels.has(first.id), false);
    });
  }
});

describe('explicit property declarations reject before local history (#6643, Q9X8)', () => {
  beforeEach(() => { seed(false); useViewerStore.setState({ editEnabled: true }); });
  it('invalid declared REAL leaves effective properties, undo, dirty state and mirror untouched', context => {
    const state = useViewerStore.getState(); const view = state.mutationViews.get(first.id); assert.ok(view);
    const mirror = context.mock.method(state, 'mirrorPropertyEdit', () => {});
    assert.throws(() => state.setProperty(first.id, 11, 'Pset_Test', 'Value', 'invalid', PropertyValueType.String, 'IfcReal'), /does not fit/);
    assert.equal(view.getMutations().length, 0); assert.equal(view.getPropertyValue(11, 'Pset_Test', 'Value'), null);
    assert.equal(useViewerStore.getState().undoStacks.size, 0); assert.equal(useViewerStore.getState().dirtyModels.size, 0);
    assert.equal(mirror.mock.callCount(), 0);
  });
  it('canonicalizes an explicit valid REAL declaration before local write and mirrors the same type', context => {
    const state = useViewerStore.getState(); const mirror = context.mock.method(state, 'mirrorPropertyEdit', () => {});
    assert.ok(state.setProperty(first.id, 11, 'Pset_Test', 'Value', 1.25, PropertyValueType.String, 'IfcReal'));
    const property = state.mutationViews.get(first.id)?.getForEntity(11).find(pset => pset.name === 'Pset_Test')?.properties[0];
    assert.equal(property?.value, 1.25); assert.equal(property?.type, PropertyValueType.Real); assert.equal(property?.dataType, 'IfcReal');
    assert.equal(mirror.mock.callCount(), 1); assert.equal(mirror.mock.calls[0]?.arguments[5], PropertyValueType.Real);
    assert.equal(useViewerStore.getState().undoStacks.get(first.id)?.length, 1);
  });
});
