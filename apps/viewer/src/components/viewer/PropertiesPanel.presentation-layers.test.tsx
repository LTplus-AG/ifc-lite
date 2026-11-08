/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider.js';
import { useViewerStore } from '@/store';
import * as layerIndex from '@/lib/presentation-layer-index.js';
import { PropertiesPanel } from './PropertiesPanel.js';
import { HierarchyPanel } from './HierarchyPanel.js';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('layers.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0GUID000000000000000001',$,'Project',$,$,$,$,$,$);
#7=IFCWALL('0GUID000000000000000007',$,'Layer wall',$,$,$,#20,$);
#8=IFCWALL('0GUID000000000000000008',$,'Unlayered wall',$,$,$,$,$);
#20=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));
#21=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#22));
#22=IFCEXTRUDEDAREASOLID($,$,$,1.);
#50=IFCPRESENTATIONLAYERASSIGNMENT('Walls',$,(#21),'A-01');
#51=IFCPRESENTATIONLAYERASSIGNMENT('Structure',$,(#22),$);
ENDSEC;
END-ISO-10303-21;`;
async function setup() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer);
  const otherStore = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC.replaceAll('Walls', 'Foreign layer')).buffer);
  const model = { ...fixtureModel('own', { idOffset: 1_000_000 }), ifcDataStore: store };
  const other = { ...fixtureModel('other', { idOffset: 2_000_000 }), ifcDataStore: otherStore };
  const view = new MutablePropertyView(null, model.id);
  useViewerStore.setState({ ...fixtureModels(model, other),
    ifcDataStore: otherStore, mutationViews: new Map([[model.id, view]]), mutationVersion: 0,
    selectedEntity: { modelId: model.id, expressId: 7 }, selectedEntityId: 1_000_007,
    selectedEntityIds: new Set([1_000_007]), selectedEntities: [], selectedModelId: null,
    hierarchyMode: 'spatial', pendingPresentationLayerReveal: null,
  });
  return { store, view, editor: new StoreEditor(store, view) };
}
const section = (ui: HTMLElement) => ui.querySelector('section[aria-label="Presentation layers"]');

it('#9273 lists both own-model layers with Identifier and omits the section for an unlayered selection', async () => {
  await setup();
  const ui = render(<PropertiesPanel />);
  assert.ok(section(ui), 'layer section appears in the actual inspector');
  assert.deepEqual([...section(ui)!.querySelectorAll('button')].map(b => b.textContent), ['Walls (A-01)', 'Structure']);
  assert.doesNotMatch(section(ui)!.textContent!, /Foreign/);
  act(() => useViewerStore.setState({ selectedEntity: { modelId: 'own', expressId: 8 },
    selectedEntityId: 1_000_008, selectedEntityIds: new Set([1_000_008]) }));
  assert.equal(section(ui), null);
});

it('#9273 clicking the second layer reveals that exact header in the hierarchy', async () => {
  await setup();
  const ui = render(<SourceHostProvider><PropertiesPanel /><HierarchyPanel /></SourceHostProvider>);
  const button = [...section(ui)!.querySelectorAll('button')].find(b => b.textContent === 'Structure');
  assert.ok(button);
  click(button);
  await waitFor(() => document.activeElement?.getAttribute('data-node-id') === 'presentation-layer-own-51',
    'clicked layer header receives focus after lazy tree load');
  assert.equal(useViewerStore.getState().hierarchyMode, 'presentation-layers');
  assert.equal(useViewerStore.getState().leftPanelCollapsed, false);
});

it('#9273 reuses the reverse index across selections and invalidates it on edits', async () => {
  const { store, view, editor } = await setup();
  assert.equal(typeof layerIndex.presentationLayersByProduct, 'function');
  const first = layerIndex.presentationLayersByProduct(store, view);
  assert.equal(layerIndex.presentationLayersByProduct(store, view), first);
  const ui = render(<PropertiesPanel />);
  editor.setAttribute(50, 'Name', 'Renamed');
  editor.setAttribute(51, 'AssignedItems', '()');
  act(() => useViewerStore.setState({ mutationVersion: 1 }));
  assert.notEqual(layerIndex.presentationLayersByProduct(store, view), first);
  assert.deepEqual([...section(ui)!.querySelectorAll('button')].map(b => b.textContent), ['Renamed (A-01)']);
});
