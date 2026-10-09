/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { EMPTY_SOURCE_BYTES, IfcParser, extractProjectUnits, extractQuantitiesOnDemand, quantitySiScale } from '@ifc-lite/parser';
import { StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { useViewerStore } from '@/store';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { ZoneVolumeBreakdown } from '@/components/viewer/ZoneVolumeBreakdown';
import { render, cleanup, type, advance } from '@/test/render';
import { MaterialTotalsPanel } from '@/components/viewer/properties/MaterialTotalsPanel';
import { summarizeSelection } from '@/components/viewer/properties/selectionSummary';
import { setGlobalRendererRef } from '@/hooks/useBCF';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });
const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
async function nativeMeasures(t: TestContext) {
  const f = await seedDeclaredZoneWall(t); if (!f) return;
  assert.equal(f.store.schemaVersion, 'IFC4', 'manifest AC20 authoring fixture uses native IFC4 records');
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  const editor = new StoreEditor(f.store, view);
  const ownerId = f.store.getEntity(f.id)?.attributes[1];
  const owner = typeof ownerId === 'number' ? `#${ownerId}` : null;
  for (const relation of f.store.entityIndex.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
    const attributes = f.store.getEntity(relation)?.attributes;
    if (!Array.isArray(attributes?.[4]) || !attributes[4].includes(f.id) || typeof attributes[5] !== 'number'
      || f.store.entities.getTypeName(attributes[5]) !== 'IfcElementQuantity') continue;
    const others = attributes[4].filter(id => id !== f.id);
    if (others.length) view.setPositionalAttribute(relation, 4, others.map(id => `#${id}`)); else view.deleteEntity(relation);
  }
  const explicitUnit = editor.addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', null, '.CUBIC_METRE.']).expressId;
  const net = editor.addEntity('IfcQuantityVolume', ['NetWitnessVolume', null, `#${explicitUnit}`, 10, null]).expressId;
  const gross = editor.addEntity('IfcQuantityVolume', ['GrossWitnessVolume', null, null, 99, null]).expressId;
  const count = editor.addEntity('IfcQuantityCount', ['UnitWitnessCount', null, null, 11, null]).expressId;
  const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner, 'UnitWitness quantities', null, null,
    [net, gross, count].map(id => `#${id}`)]).expressId;
  editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), owner, null, null, [`#${f.id}`], `#${qto}`]);
  const property = editor.addEntity('IfcPropertySingleValue', ['UnitWitnessLength', null,
    { typed: { type: 'IfcLengthMeasure', value: 7.25 } }, null]).expressId;
  const pset = editor.addEntity('IfcPropertySet', [generateIfcGuid(), owner, 'UnitWitness properties', null, [`#${property}`]]).expressId;
  editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), owner, null, null, [`#${f.id}`], `#${pset}`]);
  assert.equal(f.store.entities.getTypeName(15046), 'IfcMaterial', 'native AC20 wall material owns the material property');
  const materialProperty = editor.addEntity('IfcPropertySingleValue', ['UnitWitnessMaterialLength', null,
    { typed: { type: 'IfcLengthMeasure', value: 3.125 } }, null]).expressId;
  editor.addEntity('IfcMaterialProperties', ['UnitWitness material', null, [`#${materialProperty}`], '#15046']);
  const store = await parse(editedModelBytes(f.store, view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: store }]]), ifcDataStore: store,
    mutationViews: new Map(), storeEditors: new Map() });
  const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
  const project = store.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
  return { f, store, view: current, project };
}
function findWitness(panel: HTMLElement) {
  const find = panel.querySelector<HTMLInputElement>('input[aria-label="Find properties"]'); assert.ok(find, 'mounted native Properties Find control');
  type(find, 'Witness');
}

test('#7353 explicitly unit-bearing quantity survives unavailable project context in native card and zone basis', async t => {
  const x = await nativeMeasures(t); if (!x) return;
  x.view.setPositionalAttribute(x.project, 8, null);
  const exported = await parse(editedModelBytes(x.store, x.view));
  assert.equal(exported.getEntity(x.project)?.attributes[8], null, 'independent native export unsets UnitsInContext');
  const quantities = extractQuantitiesOnDemand(exported, x.f.id);
  const net = quantities.flatMap(set => set.quantities).find(q => q.name === 'NetWitnessVolume'); assert.ok(net);
  assert.equal(net.explicitUnitSiScale, 1, 'native quantity owns a resolvable cubic-metre unit');
  assert.equal(net.value * quantitySiScale(net, extractProjectUnits(exported.source, exported.entityIndex)), 10);
  useViewerStore.getState().setPropertiesActiveTab('quantities');
  const panel = render(<PropertiesPanel />); findWitness(panel);
  assert.match(panel.textContent ?? '', /NetWitnessVolume/, 'blanket project refusal must not erase an independently explicit quantity');
  assert.match(panel.textContent ?? '', /10 m³/, 'valid explicit physical unit remains visible');
  assert.match(panel.textContent ?? '', /UnitWitnessCount/, 'dimensionless raw quantity remains visible');
  cleanup();
  const zone = render(<ZoneVolumeBreakdown zoneSet={x.f.zoneSet} globalId={x.f.id} quantitySets={quantities}
    projectUnits={extractProjectUnits(exported.source, exported.entityIndex)} unitDisplayOverrides={{}}
    quantityUnitCoverage={{ status: 'unavailable', reason: 'Native UnitsInContext was unset' }} />);
  assert.match(zone.textContent ?? '', /net/);
  assert.match(zone.textContent ?? '', /NetWitnessVolume/, 'known explicit basis survives independently of project-unit coverage');
});

test('#7353 source-free current unit view is consulted instead of premature SI defaults', async t => {
  const x = await nativeMeasures(t); if (!x) return;
  const editor = new StoreEditor(x.store, x.view);
  const length = editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']).expressId;
  const volume = editor.addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.MILLI.', '.CUBIC_METRE.']).expressId;
  const assignment = editor.addEntity('IfcUnitAssignment', [[`#${length}`, `#${volume}`]]).expressId;
  // Actual native Project points at current records in the public view, never a stale source accessor.
  x.view.setPositionalAttribute(x.project, 8, `#${assignment}`);
  const exported = await parse(editedModelBytes(x.store, x.view));
  assert.equal(extractProjectUnits(exported.source, exported.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.siScale, 1e-9);
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  const sourceFree = { ...x.store, source: EMPTY_SOURCE_BYTES };
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: sourceFree }]]), ifcDataStore: sourceFree,
    propertiesActiveTab: 'quantities' });
  const panel = render(<PropertiesPanel />); findWitness(panel);
  assert.match(panel.textContent ?? '', /GrossWitnessVolume/);
  assert.match(panel.textContent ?? '', /99 mm³/, 'implicit raw amount uses current view cubic millimetres, not an SI-default cubic metre');
  assert.doesNotMatch(panel.textContent ?? '', /99 m³/);
});

test('#7353 implicit occurrence and material measures remain raw when current physical context is unavailable', async t => {
  const x = await nativeMeasures(t); if (!x) return;
  x.view.setPositionalAttribute(x.project, 8, null);
  const exported = await parse(editedModelBytes(x.store, x.view));
  assert.equal(exported.getEntity(x.project)?.attributes[8], null);
  useViewerStore.setState({ propertiesActiveTab: 'properties', unitDisplayOverrides: { LENGTHUNIT: 'mm' } });
  const panel = render(<PropertiesPanel />); findWitness(panel);
  assert.match(panel.textContent ?? '', /UnitWitnessLength/);
  assert.match(panel.textContent ?? '', /7\.25/, 'implicit native scalar remains readable');
  assert.match(panel.textContent ?? '', /UnitWitnessMaterialLength/);
  assert.match(panel.textContent ?? '', /3\.125/);
  assert.doesNotMatch(panel.textContent ?? '', /7,?250\s*mm|7\.25\s*m\b|3,?125\s*mm|3\.125\s*m\b/,
    'neither SI labels nor override conversion certify unavailable implicit measures');
  const summary = summarizeSelection([{ modelId: 'arch', expressId: x.f.id }],
    () => ({ store: x.store, view: x.view, modelName: 'Native fixture' }), { LENGTHUNIT: 'mm' }, 'en');
  const row = summary.properties.flatMap(group => group.rows).find(row => row.name === 'UnitWitnessLength');
  assert.equal(row?.value, '7.25', 'shared selection/copy display preserves raw native scalar without a stale physical claim');
  cleanup();
  const ownQto = x.store.entityIndex.byType.get('IFCELEMENTQUANTITY')?.find(id => x.store.getEntity(id)?.attributes[2] === 'UnitWitness quantities');
  assert.ok(ownQto);
  const members = x.store.getEntity(ownQto)?.attributes[5]; assert.ok(Array.isArray(members));
  const implicitMembers = members.filter(id => typeof id === 'number' && x.store.getEntity(id)?.attributes[0] !== 'NetWitnessVolume');
  x.view.setPositionalAttribute(ownQto, 5, implicitMembers.map(id => `#${id}`));
  const materialSource = await parse(editedModelBytes(x.store, x.view));
  const implicit = extractQuantitiesOnDemand(materialSource, x.f.id).flatMap(set => set.quantities).filter(q => q.type === 2);
  const gross = implicit.find(q => q.name === 'GrossWitnessVolume'); assert.ok(gross);
  assert.equal(gross.value, 99);
  assert.ok(implicit.every(q => q.explicitUnitSiScale === undefined), 'every aggregate volume input is implicit; the independently explicit Net member was removed');
  assert.ok(!implicit.some(q => q.name === 'NetWitnessVolume'));
  const material = render(<MaterialTotalsPanel materialId={15046} modelId="arch" />);
  await advance(50);
  assert.match(material.textContent ?? '', /UnitWitnessMaterialLength/);
  assert.match(material.textContent ?? '', /3\.125/);
  assert.doesNotMatch(material.textContent ?? '', /3,?125\s*mm|3\.125\s*m\b/,
    'selected-material property card uses the same unavailable current unit coverage');
  const volumeLabel = [...material.querySelectorAll('span')].find(span => span.textContent === 'Volume');
  assert.ok(volumeLabel, 'real native selected material has aggregated occurrence volume');
  const total = volumeLabel.nextElementSibling; assert.ok(total);
  assert.equal(total.textContent, '54.48', 'unit-context refusal preserves the measured native fixture raw aggregate instead of hiding it');
  assert.doesNotMatch(total.textContent ?? '', /[A-Za-z²³]/,
    'unavailable aggregate context preserves a raw total without a physical suffix or override conversion');
});

test('#7353 native explicit non-SI quantity unit and display override remain independent of unavailable project units', async t => {
  const x = await nativeMeasures(t); if (!x) return;
  x.view.setPositionalAttribute(x.project, 8, null);
  const netId = x.store.entityIndex.byType.get('IFCQUANTITYVOLUME')?.find(id => x.store.getEntity(id)?.attributes[0] === 'NetWitnessVolume');
  assert.ok(netId);
  const unitId = x.store.getEntity(netId)?.attributes[2]; assert.equal(typeof unitId, 'number');
  assert.ok(typeof unitId === 'number');
  x.view.setPositionalAttribute(unitId, 2, '.CENTI.');
  const exported = await parse(editedModelBytes(x.store, x.view));
  const net = extractQuantitiesOnDemand(exported, x.f.id).flatMap(set => set.quantities).find(q => q.name === 'NetWitnessVolume'); assert.ok(net);
  assert.equal(net.value, 10);
  assert.equal(net.explicitUnit, 'cm³');
  assert.equal(quantitySiScale(net, extractProjectUnits(exported.source, exported.entityIndex)), 0.01 ** 3);
  // Adopt the independently authored non-SI native fixture; live occurrence Unit edits are tracked in #7379.
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: exported }]]), ifcDataStore: exported,
    mutationViews: new Map(), storeEditors: new Map() });
  const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
  current.setPositionalAttribute(x.project, 8, null);
  useViewerStore.setState({ propertiesActiveTab: 'quantities', unitDisplayOverrides: {} });
  let panel = render(<PropertiesPanel />); findWitness(panel);
  assert.match(panel.textContent ?? '', /10 cm³/);
  cleanup();
  useViewerStore.setState({ unitDisplayOverrides: { VOLUMEUNIT: 'l' } });
  panel = render(<PropertiesPanel />); findWitness(panel);
  assert.match(panel.textContent ?? '', /0\.01 L/, 'existing converter uses the explicit native SI scale');
  assert.match(panel.textContent ?? '', /UnitWitnessCount/);
  assert.doesNotMatch(panel.textContent ?? '', /99 L|99 m³/, 'implicit raw quantity gains no physical claim');
  assert.equal(net.value, 10, 'display override leaves the native quantity unchanged');
});

test('#7353 native single-model legacy material display follows its canonical current mutation view', async t => {
  const x = await nativeMeasures(t); if (!x) return;
  x.view.setPositionalAttribute(x.project, 8, null);
  const exported = await parse(editedModelBytes(x.store, x.view));
  assert.equal(exported.getEntity(x.project)?.attributes[8], null);
  useViewerStore.setState({ models: new Map(), ifcDataStore: x.store,
    mutationViews: new Map([['__legacy__', x.view]]), unitDisplayOverrides: { LENGTHUNIT: 'mm' } });
  const material = render(<MaterialTotalsPanel materialId={15046} modelId="legacy" />);
  await advance(50);
  assert.match(material.textContent ?? '', /UnitWitnessMaterialLength/);
  assert.match(material.textContent ?? '', /3\.125/);
  assert.doesNotMatch(material.textContent ?? '', /3,?125\s*mm|3\.125\s*m\b/,
    'single-model aliases use the current view rather than restoring the original source physical context');
});
