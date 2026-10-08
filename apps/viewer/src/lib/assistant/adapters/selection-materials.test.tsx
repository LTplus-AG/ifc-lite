/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EMPTY_SOURCE_BYTES, extractAllMaterialsOnDemand, extractMaterialPropertiesOnDemand } from '@ifc-lite/parser';
import { advance, render, cleanup } from '@/test/render';
import { exportAndReparse, parseStep, seedModel } from '@/test/properties-panel-harness';
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
  MaterialLayers?: Array<{ Material: { Name: string }; IsVentilated: boolean | null; LayerThickness: { value: number; unit: string } }>;
  memberCount?: number; Materials?: Array<{ Name: string }>;
  MaterialConstituents?: Array<{ Name: string; Fraction: number; Material: { Name: string } }>;
  MaterialProfiles?: Array<{ Name: string; Material: { Name: string } }>;
}
interface Row { modelId: string; materialCount: number | null; materialsStatus: string; materials: Material[];
  materialPropertiesStatus: string; materialPropertyGroupCount: number | null;
  materialProperties: Array<{ modelId: string; expressId: number; psetCount: number | null;
    psets: Array<{ name: string; propertyCount: number | null; properties: Record<string, string> }> }> }
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
  const store = await parseStep(bytes);
  seedModel('archicad', 0, store, 15042);
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
  const prop = view.createEntity('IfcPropertySingleValue', ['Thickness', null, { typed: { type: 'IfcLengthMeasure', value: 0.25 } }, null]);
  const pset = view.createEntity('IfcMaterialProperties', ['Live dimensions', null, [`#${prop.expressId}`], '#15046']);
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1, unitDisplayOverrides: { LENGTHUNIT: 'mm' } });
  assert.equal(evidenceIsCurrent(before), false);
  assert.equal(rows()[0].materialProperties[0].psets.find(set => set.name === 'Live dimensions')?.properties.Thickness, '250 mm');
  // Public write markers must read the same before and after STEP export.
  const exported = await exportAndReparse('archicad', store);
  const fileProperty = extractMaterialPropertiesOnDemand(exported, 15042)[0].psets
    .find(set => set.name === 'Live dimensions')?.properties.find(property => property.name === 'Thickness');
  assert.equal(fileProperty?.value, 0.25);
  assert.equal(fileProperty?.dataType, 'IFCLENGTHMEASURE');
  view.deleteEntity(pset.expressId); view.deleteEntity(15060);
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(rows()[0].materialProperties[0].psetCount, 2);
  assert.ok(!rows()[0].materialProperties[0].psets.some(set => set.name === 'Live dimensions' || set.name === 'Pset_MaterialCommon'));
});

test('#7119 source-free verified materials remain known and missing wire rows remain unverified', async () => {
  const store = await sample();
  const actual = extractAllMaterialsOnDemand(store, 52)[0]; assert.ok(actual);
  seedModel('server', 0, { ...store, source: EMPTY_SOURCE_BYTES, resolvedMaterials: new Map([[52, new Map([[62, actual]])]]) }, 52);
  assert.equal(rows()[0].materials[0].Name, 'concrete_reinforced_in-situ');
  assert.equal(rows()[0].materials[0].verification, 'resolved');
  seedModel('unknown', 0, { ...store, source: EMPTY_SOURCE_BYTES, resolvedMaterials: undefined }, 52);
  assert.equal(rows()[0].materialCount, 1);
  assert.deepEqual(rows()[0].materials, [{ type: null, verification: 'unverified' }]);
  assert.equal(rows()[0].materialPropertiesStatus, 'unverified-without-source');
  assert.equal(rows()[0].materialPropertyGroupCount, null, 'unknown material property totals cannot read as zero findings');
  assert.deepEqual(rows()[0].materialProperties, []);
  assert.match(JSON.parse(captureEvidence('selection').payload).evidence.summary.limitations, /absent values are unknown/);
});

test('#7119 material collection shapes preserve native members and bound list fan-out', async () => {
  // Stated IFC collection invariant: additional associations on the real
  // slab reference its two actual materials through each native set shape.
  const list = Array.from({ length: 35 }, (_, i) => i % 2 ? '#180' : '#62').join(',');
  const additions = `#99901=IFCMATERIALLIST((${list}));
#99902=IFCMATERIALCONSTITUENT('Concrete part',$,#62,0.25,'Structural');
#99903=IFCMATERIALCONSTITUENT('Wood part',$,#180,0.75,$);
#99904=IFCMATERIALCONSTITUENTSET('Constituents',$,(#99902,#99903));
#99905=IFCRECTANGLEPROFILEDEF(.AREA.,'Rectangle',$,0.2,0.3);
#99906=IFCMATERIALPROFILE('Concrete profile',$,#62,#99905,$,'Structural');
#99907=IFCMATERIALPROFILESET('Profiles',$,(#99906),$);
#99911=IFCRELASSOCIATESMATERIAL('List association',#1,$,$,(#52),#99901);
#99912=IFCRELASSOCIATESMATERIAL('Constituent association',#1,$,$,(#52),#99904);
#99913=IFCRELASSOCIATESMATERIAL('Profile association',#1,$,$,(#52),#99907);
`;
  const source = (await sampleText()).replace('ENDSEC;\nEND-ISO-10303-21;', additions + 'ENDSEC;\nEND-ISO-10303-21;');
  seedModel('collections', 0, await parseStep(source), 52);
  const row = rows()[0]; assert.equal(row.materialCount, 4);
  const members = row.materials.find(material => material.type === 'IfcMaterialList'); assert.ok(members);
  assert.equal(members.memberCount, 35); assert.equal(members.Materials?.length, 32);
  assert.deepEqual(members.Materials?.slice(0, 2).map(member => member.Name), ['concrete_reinforced_in-situ', 'wood_mdf_plate']);
  const constituents = row.materials.find(material => material.type === 'IfcMaterialConstituentSet'); assert.ok(constituents);
  assert.deepEqual(constituents.MaterialConstituents?.map(member => [member.Name, member.Fraction, member.Material.Name]),
    [['Concrete part', 0.25, 'concrete_reinforced_in-situ'], ['Wood part', 0.75, 'wood_mdf_plate']]);
  assert.equal(row.materials.find(material => material.type === 'IfcMaterialProfileSet')?.MaterialProfiles?.[0].Material.Name,
    'concrete_reinforced_in-situ');
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
  view.createEntity('IfcRelAssociatesMaterial', ['new association', null, null, null, [`#${duplicate.expressId}`], `#${material.expressId}`]);
  const property = view.createEntity('IfcPropertySingleValue', ['B marker', null, { typed: { type: 'IfcLabel', value: 'B PROPERTY ONLY' } }, null]);
  view.createEntity('IfcMaterialProperties', ['B material set', null, [`#${property.expressId}`], '#62']);
  useViewerStore.setState({ selectedEntitiesSet: new Set([
    entityRefToString({ modelId: 'a', expressId: 52 }), entityRefToString({ modelId: 'b', expressId: duplicate.expressId })]) });
  const [aRow, bRow] = rows();
  assert.equal(aRow.modelId, 'a'); assert.deepEqual(aRow.materials.map(m => m.Name), ['concrete_reinforced_in-situ']);
  assert.equal(bRow.modelId, 'b'); assert.deepEqual(bRow.materials.map(m => m.Name), ['concrete_reinforced_in-situ', 'B ONLY']);
  assert.deepEqual(aRow.materialProperties, []);
  assert.equal(bRow.materialProperties[0].modelId, 'b'); assert.equal(bRow.materialProperties[0].expressId, 62);
  assert.equal(bRow.materialProperties[0].psets[0].properties['B marker'], 'B PROPERTY ONLY');
});

test('#7119 session associations invalidate frozen evidence and are bounded with full counts', async () => {
  seedModel('arch', 0, await sample(), 52);
  const before = captureEvidence('selection');
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view); view.setExpressIdWatermark(100_000);
  for (let i = 0; i < 20; i++) {
    const material = view.createEntity('IfcMaterial', [i === 0 ? 'x'.repeat(300) : `Session ${i}`, null, null]);
    view.createEntity('IfcRelAssociatesMaterial', [`association ${i}`, null, null, null, ['#52'], `#${material.expressId}`]);
    const properties = Array.from({ length: 40 }, (_, j) => view.createEntity('IfcPropertySingleValue',
      [`Property ${j}`, null, { typed: { type: 'IfcLabel', value: j === 0 ? 'y'.repeat(300) : 'short' } }, null]).expressId);
    view.createEntity('IfcMaterialProperties', [`Material set ${i}`, null, properties.map(id => `#${id}`), '#62']);
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


test('#7119 session-created material property groups agree with the mounted native panel', async () => {
  seedModel('arch', 0, await sample(), 52);
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const material = view.createEntity('IfcMaterial', ['Live material', null, null]);
  view.createEntity('IfcRelAssociatesMaterial', ['0000000000000000000001', null, null, null, ['#52'], `#${material.expressId}`]);
  const property = view.createEntity('IfcPropertySingleValue', ['New density', null, { typed: { type: 'IfcMassDensityMeasure', value: 1200 } }, null]);
  view.createEntity('IfcMaterialProperties', ['New material properties', null, [`#${property.expressId}`], `#${material.expressId}`]);
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  const group = rows()[0].materialProperties.find(group => group.expressId === material.expressId);
  assert.ok(group, 'newly associated material must retain its property sets');
  assert.equal(group.psets[0].properties['New density'], '1,200 kg/m³');
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  assert.match(ui.textContent ?? '', /New material properties/);
  assert.match(ui.textContent ?? '', /New density/); cleanup();
  // #7119: actual public '#id' references must survive native STEP export,
  // including both the new occurrence association and its material property group.
  const file = await exportAndReparse('arch', useViewerStore.getState().models.get('arch')!.ifcDataStore!);
  assert.ok(extractAllMaterialsOnDemand(file, 52).some(value => value.name === 'Live material'));
  const written = extractMaterialPropertiesOnDemand(file, 52).find(value => value.materialName === 'Live material');
  assert.ok(written, 'exported authored material must retain its generic property group');
  const density = written.psets[0].properties.find(value => value.name === 'New density');
  assert.equal(density?.value, 1200); assert.equal(density?.dataType, 'IFCMASSDENSITYMEASURE');
});

test('#7119 all selection caveats reach the snapshot without projection truncation', async () => {
  seedModel('arch', 0, await sample(), 52);
  const snapshot = captureEvidence('selection');
  const summary = JSON.parse(snapshot.payload).evidence.summary;
  assert.match(summary.limitations, /Classifications and relationships are excluded/);
  assert.match(summary.limitations, /selection is sampled/);
  assert.equal(snapshot.projectionTruncated, false);
});

test('#7119 missing model store reports unknown assignment totals instead of zero', async () => {
  seedModel('arch', 0, await sample(), 52);
  const models = new Map(useViewerStore.getState().models);
  const model = models.get('arch'); assert.ok(model);
  models.set('arch', { ...model, ifcDataStore: null });
  useViewerStore.setState({ models });
  assert.equal(rows()[0].materialsStatus, 'unavailable');
  assert.equal(rows()[0].materialCount, null);
  assert.deepEqual(rows()[0].materials, []);
});


test('#7119 live occurrence assignment overrides inherited type materials and their properties', async () => {
  const source = (await sampleText()).replace("(#52),#62);", "(#50),#62);")
    .replace('ENDSEC;\nEND-ISO-10303-21;', "#99997=IFCPROPERTYSINGLEVALUE('Type-only marker',$,IFCLABEL('TYPE ONLY'),$);\n#99998=IFCMATERIALPROPERTIES('Inherited material set',$,(#99997),#62);\nENDSEC;\nEND-ISO-10303-21;");
  seedModel('arch', 0, await parseStep(source), 52);
  assert.equal(rows()[0].materialProperties[0].psets[0].name, 'Inherited material set');
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const material = view.createEntity('IfcMaterial', ['Live occurrence', null, null]);
  view.createEntity('IfcRelAssociatesMaterial', ['occurrence association', null, null, null, ['#52'], `#${material.expressId}`]);
  const property = view.createEntity('IfcPropertySingleValue', ['Occurrence marker', null, { typed: { type: 'IfcLabel', value: 'OCCURRENCE ONLY' } }, null]);
  view.createEntity('IfcMaterialProperties', ['Occurrence material set', null, [`#${property.expressId}`], `#${material.expressId}`]);
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.deepEqual(rows()[0].materials.map(material => material.Name), ['Live occurrence']);
  assert.deepEqual(rows()[0].materialProperties.map(group => group.expressId), [material.expressId]);
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  assert.match(ui.textContent ?? '', /Occurrence material set/);
  assert.ok(!ui.textContent?.includes('Inherited material set'));
});

test('#7119 unset layer ventilation stays unknown while explicit false and true remain distinct', async () => {
  const additions = `#99901=IFCMATERIALLAYER(#62,0.25,$,$,$,$,$);
#99902=IFCMATERIALLAYER(#62,0.25,.F.,$,$,$,$);
#99903=IFCMATERIALLAYER(#62,0.25,.T.,$,$,$,$);
#99904=IFCMATERIALLAYERSET((#99901,#99902,#99903),'Ventilation invariant',$);
#99905=IFCRELASSOCIATESMATERIAL('Ventilation association',#1,$,$,(#52),#99904);
`;
  seedModel('arch', 0, await parseStep((await sampleText()).replace('ENDSEC;\nEND-ISO-10303-21;', additions + 'ENDSEC;\nEND-ISO-10303-21;')), 52);
  const layers = rows()[0].materials.find(material => material.LayerSetName === 'Ventilation invariant')?.MaterialLayers;
  assert.ok(layers);
  assert.deepEqual(layers.map(layer => layer.IsVentilated), [null, false, true]);
});

test('#7119 structured session material target agrees with native STEP export readback', async () => {
  const store = await sample(); seedModel('arch', 0, store, 52);
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const layer = view.createEntity('IfcMaterialLayer', ['#62', 0.25, null, null, null, null, null]);
  const set = view.createEntity('IfcMaterialLayerSet', [[`#${layer.expressId}`], 'Live layers', null]);
  view.createEntity('IfcRelAssociatesMaterial', ['0MaterialLayerRel000001', null, null, null, ['#52'], `#${set.expressId}`]);
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  const saved = await exportAndReparse('arch', store);
  const native = extractAllMaterialsOnDemand(saved, 52).find(material => material.type === 'MaterialLayerSet');
  assert.ok(native); assert.equal(native.name, 'Live layers');
  assert.equal(native.layers?.[0].thickness, 0.00025);
  const evidence = rows()[0].materials[1];
  assert.equal(evidence.type, 'IfcMaterialLayerSet');
  assert.equal(evidence.LayerSetName, native.name);
  assert.equal(evidence.MaterialLayers?.[0].LayerThickness.value, native.layers?.[0].thickness);
  assert.equal(evidence.verification, 'resolved');
});

// #7119 immutable source assignment evidence must follow real public edits.
test('#7119 source material retarget agrees with native STEP export readback', async () => {
  const store = await sample(); seedModel('retarget', 0, store, 52);
  const view = getOrCreateMutationView(useViewerStore, 'retarget'); assert.ok(view);
  view.setPositionalAttribute(61, 5, '#180');
  const file = await exportAndReparse('retarget', store);
  assert.deepEqual(extractAllMaterialsOnDemand(file, 52).map(material => material.name), ['wood_mdf_plate']);
  assert.deepEqual(rows()[0].materials.map(material => material.Name), ['wood_mdf_plate']);
});

test('#7119 deleted source material association agrees with native STEP export readback', async () => {
  const store = await sample(); seedModel('deleted', 0, store, 52);
  const view = getOrCreateMutationView(useViewerStore, 'deleted'); assert.ok(view); view.deleteEntity(61);
  const file = await exportAndReparse('deleted', store);
  assert.deepEqual(extractAllMaterialsOnDemand(file, 52), []);
  assert.equal(rows()[0].materialCount, 0); assert.deepEqual(rows()[0].materials, []);
});

test('#7119 missing wire assignment graph leaves material totals unknown', async () => {
  const store = await sample(); assert.equal(extractAllMaterialsOnDemand(store, 52).length, 1);
  // Stated transport omission: both membership inventories are absent; source
  // fields retained by accessor closures cannot prove the current wire contents.
  const wire = { ...store, source: EMPTY_SOURCE_BYTES, resolvedMaterials: undefined };
  Reflect.deleteProperty(wire, 'relationships'); Reflect.deleteProperty(wire, 'onDemandMaterialMap');
  seedModel('missing-graph', 0, wire, 52);
  assert.equal(rows()[0].materialCount, null);
  assert.equal(rows()[0].materialsStatus, 'unavailable-membership');
});

// #7119: the public named and positional writer contracts must describe the saved material.
test('#7119 source material named edits, explicit empty text and positional precedence match STEP export', async () => {
  const store = await sample(); seedModel('names', 0, store, 52);
  const view = getOrCreateMutationView(useViewerStore, 'names'); assert.ok(view);
  for (const name of ['', '$', 'Edited concrete']) {
    view.setAttribute(62, 'Name', name);
    const saved = await exportAndReparse('names', store);
    const native = extractAllMaterialsOnDemand(saved, 52)[0]; assert.ok(native);
    assert.equal(native.name, name === '$' ? undefined : name);
    assert.equal(rows()[0].materials[0].Name, native.name ?? null);
  }
  view.setPositionalAttribute(62, 0, 'Positional concrete');
  const saved = await exportAndReparse('names', store);
  assert.equal(extractAllMaterialsOnDemand(saved, 52)[0].name, 'Positional concrete');
  assert.equal(rows()[0].materials[0].Name, 'Positional concrete');
});

test('#7119 source type membership reassignment replaces inherited material evidence after export', async () => {
  const inherited = (await sampleText()).replace('(#52),#62);', '(#50),#62);');
  const store = await parseStep(inherited); seedModel('types', 0, store, 52);
  assert.equal(rows()[0].materials[0].Name, 'concrete_reinforced_in-situ');
  const view = getOrCreateMutationView(useViewerStore, 'types'); assert.ok(view);
  view.setPositionalAttribute(51, 5, '#174');
  const saved = await exportAndReparse('types', store);
  assert.deepEqual(extractAllMaterialsOnDemand(saved, 52), []);
  assert.equal(rows()[0].materialCount, 0);
});

test('#7119 source-empty source-association edits retain only unverified original markers with unknown totals', async () => {
  const source = await sample();
  const actual = extractAllMaterialsOnDemand(source, 52)[0]; assert.ok(actual);
  seedModel('wire-edit', 0, { ...source, source: EMPTY_SOURCE_BYTES,
    resolvedMaterials: new Map([[52, new Map([[62, actual]])]]) }, 52);
  const view = getOrCreateMutationView(useViewerStore, 'wire-edit'); assert.ok(view);
  view.setPositionalAttribute(61, 5, '#180');
  const row = rows()[0];
  assert.equal(row.materialCount, null);
  assert.equal(row.materialsStatus, 'unavailable-membership');
  assert.deepEqual(row.materials, [{ type: null, verification: 'unverified' }]);
});
