/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { render, cleanup } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { texturedProductSource } from '@/test/textured-product-fixture';
import { rebuildSpatialHierarchy } from '@/utils/spatialHierarchy';
import { useIfcAuthoringTarget } from './useIfcAuthoringTarget';
afterEach(cleanup);
function Destination() {
  const target = useIfcAuthoringTarget();
  return <div><output>{target.modelId}:{target.containerId ?? ''}</output>
    {target.eligible.map(model => <span key={model.id}>{model.id}</span>)}</div>;
}
test('authoring targets require an editable IFC with a spatial destination, not only an IFC4 schema tag #4380', async () => {
  const data = await new IfcParser().parseColumnar(texturedProductSource.slice().buffer);
  data.spatialHierarchy = rebuildSpatialHierarchy(data.entities, data.relationships);
  const valid = { ...fixtureModel('editable'), schemaVersion: 'IFC4' as const, ifcDataStore: data };
  const readonly = { ...valid, id: 'readonly' };
  // Mesh imports can carry an IFC4-tagged minimal store without spatial nodes.
  const mesh = { ...valid, id: 'mesh', ifcDataStore: { ...data, spatialHierarchy: undefined } };
  useViewerStore.setState({ models: new Map([['mesh', mesh], ['readonly', readonly], ['editable', valid]]),
    activeModelId: 'mesh', activeStorey: null,
    mutationViews: new Map([['editable', new MutablePropertyView(data.properties, 'editable')], ['mesh', new MutablePropertyView(data.properties, 'mesh')]]) });
  const ui = render(<Destination />);
  assert.deepEqual([...ui.querySelectorAll('span')].map(node => node.textContent), ['editable']);
  assert.equal(ui.querySelector('output')?.textContent, 'editable:40');
  act(() => useViewerStore.setState({ mutationViews: new Map() }));
  assert.equal(ui.querySelector('output')?.textContent, ':');
  assert.equal(ui.querySelectorAll('span').length, 0);
});
