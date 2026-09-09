/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { render, cleanup, click, type } from '@/test/render';
import { rebuildSpatialHierarchy } from '@/utils/spatialHierarchy';
import { AppearanceAnnotationFields } from './AppearanceAnnotationFields';

afterEach(() => { cleanup(); useViewerStore.setState({ models: new Map(), activeModelId: null, activeStorey: null, collabRoomId: null }); });
async function model(id: string, level: number) {
  const bytes = new TextEncoder().encode(`ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('a.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Project000000000000000',$,'Project',$,$,$,$,$,$);
#${level}=IFCBUILDINGSTOREY('0Storey0000000000000000',$,'${id} level',$,$,$,$,$,.ELEMENT.,0.);
#999=IFCRELAGGREGATES('0ccccccccccccccccccccc',$,$,$,#1,(#${level}));
ENDSEC;END-ISO-10303-21;`);
  const data = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
  data.spatialHierarchy = rebuildSpatialHierarchy(data.entities, data.relationships);
  return { ...fixtureModel(id), schemaVersion: 'IFC4', ifcDataStore: data };
}
function select(ui: HTMLElement, label: string) {
  const input = ui.querySelector(`select[aria-label="${label}"]`);
  assert.ok(input instanceof HTMLSelectElement); return input;
}
function create(ui: HTMLElement) {
  const button = [...ui.querySelectorAll('button')].find(item => item.textContent === 'Create annotation');
  assert.ok(button); return button;
}
test('annotation target follows the chosen model and never offers IfcProject as containment (#4308)', async () => {
  const a = await model('A', 40), b = await model('B', 80);
  useViewerStore.setState({ models: new Map([['A', a], ['B', b]]), activeModelId: 'A', activeStorey: { modelId: 'A', expressId: 40 } });
  const ui = render(<AppearanceAnnotationFields referenceId="drawing" name="Plan" disabled={false} />);
  assert.equal(select(ui, 'Annotation container').value, '40');
  assert.deepEqual([...select(ui, 'Annotation container').options].map(option => option.value), ['40']);
  act(() => { const input = select(ui, 'Annotation model'); input.value = 'B'; input.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(select(ui, 'Annotation container').value, '80');
  const name = ui.querySelector('input[aria-label="Annotation Name"]'); assert.ok(name instanceof HTMLInputElement);
  type(name, ''); assert.equal(create(ui).disabled, true);
  type(name, 'Facade'); assert.equal(create(ui).disabled, false);
  click(create(ui));
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /3D view/);
  assert.equal(useViewerStore.getState().mutationViews.has('B'), false, 'No command publishes before a renderer exists');
});
test('annotation creation is unavailable without a spatial target or in a shared room (#4308)', async () => {
  useViewerStore.setState({ models: new Map(), activeModelId: null });
  let ui = render(<AppearanceAnnotationFields referenceId="drawing" name="Plan" disabled={false} />);
  assert.equal(create(ui).disabled, true);
  cleanup();
  const a = await model('A', 40);
  useViewerStore.setState({ models: new Map([['A', a]]), activeModelId: 'A', collabRoomId: 'room' });
  ui = render(<AppearanceAnnotationFields referenceId="drawing" name="Plan" disabled={false} />);
  assert.equal(ui.querySelector('fieldset')?.disabled, true);
  assert.match(ui.textContent ?? '', /Leave the shared room/);
});
