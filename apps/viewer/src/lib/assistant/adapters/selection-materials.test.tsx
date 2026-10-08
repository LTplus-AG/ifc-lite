/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractAllMaterialsOnDemand } from '@ifc-lite/parser';
import { advance, render, cleanup } from '@/test/render';
import { parseStep, seedModel } from '@/test/properties-panel-harness';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { useViewerStore } from '@/store';
import { entityRefToString } from '@/store/entity-ref';
import { captureEvidence, evidenceIsCurrent } from '../evidence';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
const sampleText = () => readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8');
const sample = async () => parseStep(await sampleText());
interface Material {
  type: string | null; verification: string; Name?: string; LayerSetName?: string;
  MaterialLayers?: Array<{ Material: { Name: string }; LayerThickness: { value: number; unit: string } }>;
}
interface Row { modelId: string; materialCount: number; materials: Material[];
  materialPropertiesStatus: string; materialPropertyGroupCount: number;
  materialProperties: Array<{ modelId: string; expressId: number; psetCount: number;
    psets: Array<{ name: string; propertyCount: number; properties: Record<string, string> }> }> }
const rows = (): Row[] => JSON.parse(captureEvidence('selection').payload).evidence.rows.map((row: { data: Row }) => row.data);

// #7119: SketchUp's source #61 assigns #62 to slab #52. Evidence uses this
// actual authored association, and the mounted panel shows the same name.
test('#7119 real SketchUp occurrence material agrees with the native panel', async () => {
  seedModel('arch', 0, await sample(), 52);
  assert.equal(rows()[0].materialCount, 1);
  assert.deepEqual(rows()[0].materials.map(m => [m.type, m.Name, m.verification]),
    [['IfcMaterial', 'concrete_reinforced_in-situ', 'resolved']]);
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  assert.match(ui.textContent ?? '', /concrete_reinforced_in-situ/);
});

test('#7119 native type fallback and occurrence precedence use the same IFC material graph', async () => {
  // Stated invariant: moving the real #61 association to its real type #50
  // makes it inherited. A new occurrence association must then override it.
  const inherited = (await sampleText()).replace("(#52),#62);", "(#50),#62);");
  seedModel('arch', 0, await parseStep(inherited), 52);
  assert.equal(rows()[0].materials[0].Name, 'concrete_reinforced_in-situ');
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  assert.match(ui.textContent ?? '', /concrete_reinforced_in-situ/); cleanup();
  const overridden = inherited.replace('ENDSEC;\nEND-ISO-10303-21;',
    "#99999=IFCRELASSOCIATESMATERIAL('0MEUM3gDb4HQJkmZ0$VlbL',#1,$,$,(#52),#180);\nENDSEC;\nEND-ISO-10303-21;");
  seedModel('arch', 0, await parseStep(overridden), 52);
  assert.deepEqual(rows()[0].materials.map(m => m.Name), ['wood_mdf_plate']);
});

test('#7119 real ArchiCAD layer usage preserves material name and metre thickness', async t => {
  const fixture = new URL('../../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(fixture)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { t.skip('run pnpm fixtures to fetch AC20-FZK-Haus.ifc'); return; }
    throw error;
  }
  seedModel('archicad', 0, await parseStep(bytes), 15042);
  const material = rows()[0].materials[0];
  assert.equal(material.type, 'IfcMaterialLayerSet');
  assert.equal(material.LayerSetName, 'Leichtbeton 102890359 0.24');
  assert.deepEqual(material.MaterialLayers?.[0].LayerThickness, { value: 0.24, unit: 'm' });
  assert.equal(rows()[0].materialPropertiesStatus, 'available');
  const group = rows()[0].materialProperties[0];
  assert.equal(group.modelId, 'archicad'); assert.equal(group.expressId, 15046);
  assert.equal(group.psetCount, 3);
  assert.equal(group.psets.find(pset => pset.name === 'Pset_MaterialCommon')?.properties.MassDensity, '0 kg/m³');
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  assert.match(ui.textContent ?? '', /Leichtbeton 102890359 0\.24/);
  assert.match(ui.textContent ?? '', /Pset_MaterialCommon/); cleanup();
  const before = captureEvidence('selection');
  const view = getOrCreateMutationView(useViewerStore, 'archicad'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const prop = view.createEntity('IfcPropertySingleValue', ['Thickness', null, ['IFCLENGTHMEASURE', 0.25], null]);
  const pset = view.createEntity('IfcMaterialProperties', ['Live dimensions', null, [prop.expressId], 15046]);
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1, unitDisplayOverrides: { LENGTHUNIT: 'mm' } });
  assert.equal(evidenceIsCurrent(before), false);
  assert.equal(rows()[0].materialProperties[0].psets.find(set => set.name === 'Live dimensions')?.properties.Thickness, '250 mm');
  view.deleteEntity(pset.expressId); view.deleteEntity(15060);
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(rows()[0].materialProperties[0].psetCount, 2);
  assert.ok(!rows()[0].materialProperties[0].psets.some(set => set.name === 'Live dimensions' || set.name === 'Pset_MaterialCommon'));
});

test('#7119 source-free verified materials remain known and missing wire rows remain unverified', async () => {
  const store = await sample();
  const actual = extractAllMaterialsOnDemand(store, 52)[0]; assert.ok(actual);
  seedModel('server', 0, { ...store, source: new Uint8Array(), resolvedMaterials: new Map([[52, new Map([[62, actual]])]]) }, 52);
  assert.equal(rows()[0].materials[0].Name, 'concrete_reinforced_in-situ');
  assert.equal(rows()[0].materials[0].verification, 'resolved');
  seedModel('unknown', 0, { ...store, source: new Uint8Array(), resolvedMaterials: undefined }, 52);
  assert.equal(rows()[0].materialCount, 1);
  assert.deepEqual(rows()[0].materials, [{ type: null, verification: 'unverified' }]);
  assert.equal(rows()[0].materialPropertiesStatus, 'unverified-without-source');
  assert.deepEqual(rows()[0].materialProperties, []);
  assert.match(JSON.parse(captureEvidence('selection').payload).evidence.summary.limitations, /absent values are unknown/);
});

test('#7119 overlay aliases and independent federation retain model-specific material assignments', async () => {
  seedModel('a', 0, await sample(), 52);
  const models = new Map(useViewerStore.getState().models); const a = models.get('a'); assert.ok(a);
  models.set('b', { ...a, id: 'b', name: 'b', idOffset: 1_000_000, ifcDataStore: await sample() });
  useViewerStore.setState({ models });
  const view = getOrCreateMutationView(useViewerStore, 'b'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const duplicate = view.createEntity('IfcSlab', ['duplicate', null, 'duplicate']);
  view.setEntityAlias(duplicate.expressId, 52);
  const material = view.createEntity('IfcMaterial', ['B ONLY', null, null]);
  view.createEntity('IfcRelAssociatesMaterial', ['new association', null, null, null, [duplicate.expressId], material.expressId]);
  useViewerStore.setState({ selectedEntitiesSet: new Set([
    entityRefToString({ modelId: 'a', expressId: 52 }), entityRefToString({ modelId: 'b', expressId: duplicate.expressId })]) });
  const [aRow, bRow] = rows();
  assert.equal(aRow.modelId, 'a'); assert.deepEqual(aRow.materials.map(m => m.Name), ['concrete_reinforced_in-situ']);
  assert.equal(bRow.modelId, 'b'); assert.deepEqual(bRow.materials.map(m => m.Name), ['concrete_reinforced_in-situ', 'B ONLY']);
});

test('#7119 session associations invalidate frozen evidence and are bounded with full counts', async () => {
  seedModel('arch', 0, await sample(), 52);
  const before = captureEvidence('selection');
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view); view.setExpressIdWatermark(100_000);
  for (let i = 0; i < 20; i++) {
    const material = view.createEntity('IfcMaterial', [i === 0 ? 'x'.repeat(300) : `Session ${i}`, null, null]);
    view.createEntity('IfcRelAssociatesMaterial', [`association ${i}`, null, null, null, [52], material.expressId]);
    const properties = Array.from({ length: 40 }, (_, j) => view.createEntity('IfcPropertySingleValue',
      [`Property ${j}`, null, ['IFCLABEL', j === 0 ? 'y'.repeat(300) : 'short'], null]).expressId);
    view.createEntity('IfcMaterialProperties', [`Material set ${i}`, null, properties, 62]);
  }
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(before), false);
  assert.equal(rows()[0].materialCount, 21);
  assert.equal(rows()[0].materials.length, 16);
  assert.equal(rows()[0].materials[1].Name?.length, 241);
  const group = rows()[0].materialProperties[0];
  assert.equal(group.psetCount, 20); assert.equal(group.psets.length, 16);
  assert.equal(group.psets[0].propertyCount, 40); assert.equal(Object.keys(group.psets[0].properties).length, 32);
  assert.equal(group.psets[0].properties['Property 0'].length, 241);
});
