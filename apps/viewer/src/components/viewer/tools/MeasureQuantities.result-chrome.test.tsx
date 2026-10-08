/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { act } from 'react';
import { FederationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { entityRefToString } from '@/store/types';
import { seedZoneExport } from '@/test/zone-export-fixture';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { cleanup, render } from '@/test/render';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { MeasureQuantities } from './MeasureQuantities';

const initial = useViewerStore.getState();
beforeEach(() => useViewerStore.setState(initial, true));
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
async function nativeSelection() {
  const native = await seedZoneExport();
  const model = useViewerStore.getState().models.get('bonsai'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['bonsai', { ...model, name: 'Bonsai wall.ifc' }]]),
    selectedEntity: { modelId: 'bonsai', expressId: native.wall.expressId }, selectedEntitiesSet: new Set(),
    unitDisplayOverrides: {}, activeTool: 'measure' });
  return { ...native, model: { ...model, name: 'Bonsai wall.ifc' } };
}
function region(ui: HTMLElement) {
  const result = ui.querySelector('section[aria-label="Quantities results"]');
  assert.ok(result, '#7184 native quantity panel uses the shared ResultView'); return result;
}
function value(ui: HTMLElement, label: string) {
  const node = [...ui.querySelectorAll('span')].find(span => span.textContent?.trim() === label); assert.ok(node, label);
  const text = node.parentElement?.children[1]?.textContent; assert.ok(text);
  const number = text.replaceAll(',', '').match(/[-+]?\d*\.?\d+/)?.[0]; assert.ok(number, text); return Number(number);
}
const mount = () => render(<TooltipProvider><MeasureQuantities /></TooltipProvider>);

it('#7184 native Measurements Qty tab shows authored model source and actual kernel measurement', async t => {
  if (!ensureWasm(t)) return;
  const native = await nativeSelection();
  const ui = render(<TooltipProvider>{renderPanelBody('measurements', () => {})}</TooltipProvider>);
  const tab = [...ui.querySelectorAll('[role="tab"]')].find(node => node.textContent?.trim() === 'Qty'); assert.ok(tab);
  act(() => { tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); });
  assert.match(region(ui).textContent ?? '', /Bonsai wall.ifc/);
  assert.match(region(ui).textContent ?? '', /1 selected element/);
  assert.ok(native.wall.geometryVolume && native.wall.geometryVolume > 0);
  assert.ok(Math.abs(value(ui, 'Volume mesh') - native.wall.geometryVolume) < 0.01, 'display derives from the actual proved kernel volume');
  assert.ok(value(ui, 'Area mesh') > 0, 'actual triangles remain independently measurable');
  assert.ok(region(ui).querySelector('section[aria-label="Evidence details"]'), 'native source inspection occupies the evidence region');
});
it('#7184 native federated quantity sources follow actual selected refs and preserve model-qualified geometry totals', async t => {
  if (!ensureWasm(t)) return;
  const first = await nativeSelection(), second = await seedZoneExport();
  const registry = new FederationRegistry();
  const max = Math.max(...first.store.entities.expressId);
  const firstOffset = registry.registerModel('first', max), secondOffset = registry.registerModel('second', max);
  const models = new Map([
    ['first', { ...first.model, id: 'first', name: 'First Bonsai.ifc', idOffset: firstOffset,
      geometryResult: { ...first.geometry, meshes: first.meshes.map(mesh => ({ ...mesh, expressId: registry.toGlobalId('first', mesh.expressId) })) } }],
    ['second', { ...first.model, id: 'second', name: 'Second Bonsai.ifc', idOffset: secondOffset, ifcDataStore: second.store,
      geometryResult: { ...second.geometry, meshes: second.meshes.map(mesh => ({ ...mesh, expressId: registry.toGlobalId('second', mesh.expressId) })) } }],
  ]);
  const a = { modelId: 'first', expressId: first.wall.expressId }, b = { modelId: 'second', expressId: second.wall.expressId };
  useViewerStore.setState({ models, activeModelId: 'second', ifcDataStore: second.store, selectedEntity: a,
    selectedEntitiesSet: new Set([entityRefToString(a), entityRefToString(b)]) });
  const ui = mount();
  assert.match(region(ui).textContent ?? '', /First Bonsai.ifc, Second Bonsai.ifc/);
  assert.match(region(ui).textContent ?? '', /2 selected elements/);
  const expected = (first.wall.geometryVolume ?? 0) + (second.wall.geometryVolume ?? 0); assert.ok(expected > 0);
  assert.ok(Math.abs(value(ui, 'Volume mesh') - expected) < 0.01);
  await act(async () => { useViewerStore.setState({ selectedEntitiesSet: new Set([entityRefToString(a)]) }); });
  assert.match(region(ui).textContent ?? '', /First Bonsai.ifc/); assert.doesNotMatch(region(ui).textContent ?? '', /Second Bonsai.ifc/);
  assert.ok(Math.abs(value(ui, 'Volume mesh') - (first.wall.geometryVolume ?? 0)) < 0.01);
});
it('#7184 actual mesh area remains measurable when selected model table data is unavailable', async t => {
  if (!ensureWasm(t)) return;
  const native = await nativeSelection();
  useViewerStore.setState({ models: new Map([['bonsai', { ...native.model, ifcDataStore: null }]]), ifcDataStore: null });
  const ui = mount();
  assert.ok(region(ui).querySelector('[data-status="partial"]'));
  assert.match(region(ui).textContent ?? '', /could not be resolved to a loaded model/);
  assert.ok(value(ui, 'Area mesh') > 0, 'store unavailability cannot discard actual native mesh area');
  assert.equal(Boolean(ui.querySelector('[data-result-state="no-findings"]')), false);
});
it('#7184 native alignment volume withholding remains Partial while real mesh area stays available', async t => {
  if (!ensureWasm(t)) return;
  const native = await nativeSelection();
  useViewerStore.setState({ models: new Map([['bonsai', { ...native.model, federationAlignmentStatus: 'reprojected' }]]) });
  const ui = mount();
  assert.ok(region(ui).querySelector('[data-status="partial"]'));
  assert.match(region(ui).textContent ?? '', /alignment rescaled/);
  // #7184 review: shared coverage must own this disclosure exactly once.
  assert.equal((region(ui).textContent ?? '').match(/alignment rescaled/g)?.length, 1);
  assert.ok(value(ui, 'Area mesh') > 0);
  assert.equal(Boolean([...ui.querySelectorAll('span')].find(span => span.textContent?.trim() === 'Volume mesh')), false);
});
it('#7184 withholding absent volume proof does not hide an actual native mesh area result', async t => {
  if (!ensureWasm(t)) return;
  const native = await nativeSelection();
  const geometry = { ...native.geometry, meshes: native.meshes.map(mesh => ({ ...mesh, geometryVolume: undefined })) };
  useViewerStore.setState({ models: new Map([['bonsai', { ...native.model, geometryResult: geometry }]]), geometryResult: geometry });
  const ui = mount();
  assert.ok(region(ui).querySelector('[data-status="partial"]'));
  assert.match(region(ui).textContent ?? '', /no provable enclosed volume/);
  assert.ok(value(ui, 'Area mesh') > 0);
});
it('#7184 a selected unavailable source is Partial and never no-findings', async t => {
  if (!ensureWasm(t)) return;
  const native = await nativeSelection();
  useViewerStore.setState({ models: new Map([['bonsai', { ...native.model, ifcDataStore: null, geometryResult: null }]]),
    ifcDataStore: null, geometryResult: null });
  const ui = mount();
  assert.ok(region(ui).querySelector('[data-status="partial"]'));
  assert.ok(region(ui).querySelector('[data-result-state="partial"]'));
  assert.equal(Boolean(region(ui).querySelector('[data-result-state="no-findings"]')), false);
  assert.match(region(ui).textContent ?? '', /1 selected element/);
});
it('#7184 actual empty selection has a no-population state without claiming an evaluated count', async t => {
  if (!ensureWasm(t)) return;
  await nativeSelection(); useViewerStore.setState({ selectedEntity: null, selectedEntitiesSet: new Set() });
  const ui = mount();
  assert.ok(region(ui).querySelector('[data-result-state="no-population"]'));
  assert.match(region(ui).textContent ?? '', /0 selected elements/);
  assert.equal(Boolean(region(ui).querySelector('[data-status="complete"]')), false);
});
it('#7184 measured zero surface area over finite degenerate native triangles stays a result', async t => {
  if (!ensureWasm(t)) return;
  const native = await nativeSelection();
  // Stated measurement invariant: finite zero triangle area is measured, not an absent mesh.
  const geometry = { ...native.geometry, meshes: native.meshes.map(mesh => ({ ...mesh,
    positions: new Float32Array(mesh.positions.length), geometryVolume: undefined })) };
  useViewerStore.setState({ models: new Map([['bonsai', { ...native.model, geometryResult: geometry }]]), geometryResult: geometry });
  const ui = mount();
  assert.equal(value(ui, 'Area mesh'), 0);
  assert.equal(Boolean(region(ui).querySelector('[data-result-state="partial"]')), false, 'zero-valued rows are not an empty result');
  assert.ok(region(ui).querySelector('[data-status="partial"]'), 'independent missing volume remains disclosed');
});

for (const modelId of ['legacy', 'bonsai']) it(`#7184 native single-slot fallback retains known source caption for ${modelId} refs with no federation map`, async t => {
  if (!ensureWasm(t)) return;
  const native = await nativeSelection();
  useViewerStore.setState({ models: new Map(), activeModelId: 'bonsai', ifcDataStore: native.store,
    geometryResult: native.geometry, selectedEntity: { modelId, expressId: native.wall.expressId }, selectedEntitiesSet: new Set() });
  const ui = mount();
  assert.ok(Math.abs(value(ui, 'Volume mesh') - (native.wall.geometryVolume ?? 0)) < 0.01, 'existing native single-slot fallback computes the known quantity');
  assert.doesNotMatch(region(ui).textContent ?? '', /Unavailable model/);
  assert.match(region(ui).textContent ?? '', /Single-model source/);
});
