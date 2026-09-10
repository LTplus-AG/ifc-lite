/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { render, cleanup } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { texturedProductSource } from '@/test/textured-product-fixture';
import { rebuildSpatialHierarchy } from '@/utils/spatialHierarchy';
import { selectCreatedAppearanceObject } from './select-created-object';
import { hasWorkspaceHistory, replayWorkspaceHistory } from '@/lib/model-placement/history';
import { prepareAuthoredProduct } from '@/lib/appearance/prepare-authored-product';
import { useIfcAuthoringTarget } from './useIfcAuthoringTarget';
afterEach(cleanup);
function Destination() {
  const target = useIfcAuthoringTarget();
  return <div><output>{target.modelId}:{target.containerId ?? ''}</output>
    {target.eligible.map(model => <span key={model.id}>{model.id}</span>)}</div>;
}
test('authoring destinations are eligible before lazy mutation views exist, while mesh-only stores remain excluded #4412', async () => {
  const data = await new IfcParser().parseColumnar(texturedProductSource.slice().buffer);
  data.spatialHierarchy = rebuildSpatialHierarchy(data.entities, data.relationships);
  const valid = { ...fixtureModel('editable'), schemaVersion: 'IFC4' as const, ifcDataStore: data };
  const lazy = { ...valid, id: 'lazy' };
  // Mesh imports can carry an IFC4-tagged minimal store without spatial nodes.
  const mesh = { ...valid, id: 'mesh', ifcDataStore: { ...data, spatialHierarchy: undefined } };
  useViewerStore.setState({ models: new Map([['mesh', mesh], ['lazy', lazy], ['editable', valid]]),
    activeModelId: 'mesh', activeStorey: null,
    mutationViews: new Map([['editable', new MutablePropertyView(data.properties, 'editable')], ['mesh', new MutablePropertyView(data.properties, 'mesh')]]) });
  const ui = render(<Destination />);
  assert.deepEqual([...ui.querySelectorAll('span')].map(node => node.textContent), ['lazy', 'editable']);
  assert.equal(ui.querySelector('output')?.textContent, 'lazy:40');
  act(() => useViewerStore.setState({ mutationViews: new Map() }));
  assert.equal(ui.querySelector('output')?.textContent, 'lazy:40');
  assert.equal(ui.querySelectorAll('span').length, 2);
});

test('both textured creation consumers receive effective IFC bytes from a lazily initialized canonical view #4412', async () => {
  const data = await new IfcParser().parseColumnar(texturedProductSource.slice().buffer);
  data.spatialHierarchy = rebuildSpatialHierarchy(data.entities, data.relationships);
  const model = { ...fixtureModel('lazy'), schemaVersion: 'IFC4' as const, ifcDataStore: data };
  useViewerStore.setState({ models: new Map([['lazy', model]]), mutationViews: new Map(), collabRoomId: null });
  const prepared = await prepareAuthoredProduct('lazy');
  const canonical = useViewerStore.getState().mutationViews.get('lazy');
  assert.ok(canonical);
  const first = await new IfcParser().parseColumnar(prepared.bytes.slice().buffer);
  assert.equal(first.entities.getName(40), 'Level');
  new StoreEditor(data, canonical).setAttribute(40, 'Name', 'Retained destination edit');
  const edited = await prepareAuthoredProduct('lazy');
  assert.equal(useViewerStore.getState().mutationViews.get('lazy'), canonical);
  const roundtrip = await new IfcParser().parseColumnar(edited.bytes.slice().buffer);
  assert.equal(roundtrip.entities.getName(40), 'Retained destination edit');
});

test('selecting a created destination object makes its actual mutation history available after a scan was active #4412', async () => {
  const data = await new IfcParser().parseColumnar(texturedProductSource.slice().buffer);
  const model = { ...fixtureModel('destination'), schemaVersion: 'IFC4' as const, ifcDataStore: data };
  useViewerStore.setState({ models: new Map([['scan', fixtureModel('scan')], ['destination', model]]), activeModelId: 'scan', mutationViews: new Map(), undoStacks: new Map(), redoStacks: new Map(), collabRoomId: null });
  await prepareAuthoredProduct('destination');
  useViewerStore.getState().setAttribute('destination', 40, 'Name', 'Authored name');
  assert.equal(hasWorkspaceHistory(useViewerStore.getState(), 'undo'), false);
  selectCreatedAppearanceObject('destination', { expressId: 40, globalId: 40 });
  assert.equal(hasWorkspaceHistory(useViewerStore.getState(), 'undo'), true);
  replayWorkspaceHistory(useViewerStore.getState(), 'undo');
  const restored = await prepareAuthoredProduct('destination');
  const roundtrip = await new IfcParser().parseColumnar(restored.bytes.slice().buffer);
  assert.equal(roundtrip.entities.getName(40), 'Level');
});
