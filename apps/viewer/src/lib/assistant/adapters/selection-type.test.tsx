/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PropertyValueType, PropertyTableBuilder, StringTable } from '@ifc-lite/data';
import { extractTypePropertiesOnDemand } from '@ifc-lite/parser';
import { advance, render, cleanup, click } from '@/test/render';
import { parseStep, seedModel } from '@/test/properties-panel-harness';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { useViewerStore } from '@/store';
import { entityRefToString } from '@/store/entity-ref';
import { captureEvidence, evidenceIsCurrent } from '../evidence';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
const sample = async () => parseStep(new Uint8Array(await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url))));
interface Row {
  modelId: string;
  psets: Array<{ name: string; properties: Record<string, string> }>;
  inheritedType: null | { modelId: string; GlobalId: string; Name: string; status: string; expressId: number; psetCount: number;
    psets: Array<{ name: string; propertyCount: number; properties: Record<string, string> }> };
}
const rows = () => JSON.parse(captureEvidence('selection').payload).evidence.rows.map((row: { data: Row }) => row.data) as Row[];
const inherited = () => { const value = rows()[0].inheritedType; assert.ok(value); return value; };

// #7104: committed SketchUp IFC declares #52 IfcSlab -> #50 IfcSlabType,
// HasPropertySets #963 with FireRating REI60. No fabricated type relationship.
test('#7104 real SketchUp type evidence has exact model/type provenance and matches the panel', async () => {
  seedModel('arch', 0, await sample(), 52);
  const type = inherited();
  assert.equal(type.modelId, 'arch');
  assert.equal(type.GlobalId, '0hnSKr4LD8eRixcnqcc6X1');
  assert.equal(type.Name, 'house - groundfloor');
  assert.equal(type.expressId, 50);
  assert.equal(type.psets[0].name, 'Pset_SlabCommon');
  assert.equal(type.psets[0].properties.FireRating, 'REI60');
  const ui = render(renderPanelBody('properties', () => undefined));
  await advance(0);
  const trigger = [...ui.querySelectorAll('button')].find(button => button.textContent?.includes('Pset_SlabCommon'));
  assert.ok(trigger); click(trigger); await advance(0);
  assert.ok(ui.querySelector('[data-prop-key="50:Pset_SlabCommon:FireRating"]'));
  assert.match(ui.textContent ?? '', /REI60/);
});

test('#7104 type edits invalidate evidence; occurrence overrides remain separate and type deletion stays deleted', async () => {
  seedModel('arch', 1_000_000, await sample(), 52);
  assert.ok(getOrCreateMutationView(useViewerStore, 'arch'));
  const before = captureEvidence('selection');
  const state = useViewerStore.getState();
  assert.ok(state.setProperty('arch', 50, 'Pset_SlabCommon', 'FireRating', 'REI90', PropertyValueType.Label));
  assert.ok(state.setProperty('arch', 52, 'Pset_SlabCommon', 'FireRating', 'REI120', PropertyValueType.Label));
  assert.equal(evidenceIsCurrent(before), false);
  assert.equal(inherited().status, 'edited');
  assert.equal(inherited().psets[0].properties.FireRating, 'REI90');
  assert.equal(rows()[0].psets.find(pset => pset.name === 'Pset_SlabCommon')?.properties.FireRating, 'REI120');
  assert.ok(state.deletePropertySet('arch', 50, 'Pset_SlabCommon'));
  assert.equal(inherited().psetCount, 0);
  assert.deepEqual(inherited().psets, []);
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  assert.ok(!ui.textContent?.includes('REI60'), 'loaded type set must not resurrect after deletion');
  assert.ok(!ui.querySelector('[data-prop-key="50:Pset_SlabCommon:FireRating"]'));
});

test('#7104 two models with the same local type id preserve their own edited definitions and display units', async () => {
  seedModel('a', 0, await sample(), 52);
  const models = new Map(useViewerStore.getState().models);
  const a = models.get('a'); assert.ok(a);
  models.set('b', { ...a, id: 'b', name: 'b', idOffset: 1_000_000, ifcDataStore: await sample() });
  useViewerStore.setState({ models, selectedEntitiesSet: new Set(['a', 'b'].map(modelId => entityRefToString({ modelId, expressId: 52 }))),
    unitDisplayOverrides: { LENGTHUNIT: 'm' } });
  for (const modelId of ['a', 'b']) assert.ok(getOrCreateMutationView(useViewerStore, modelId));
  const state = useViewerStore.getState();
  assert.ok(state.setProperty('a', 50, 'Pset_SlabCommon', 'FireRating', 'A ONLY', PropertyValueType.Label));
  assert.ok(state.setProperty('b', 50, 'Pset_SlabCommon', 'Thickness', 250, PropertyValueType.Real, 'IfcLengthMeasure'));
  const [aRow, bRow] = rows();
  assert.equal(aRow.inheritedType?.psets[0].properties.FireRating, 'A ONLY');
  assert.equal(bRow.inheritedType?.psets[0].properties.FireRating, 'REI60');
  assert.equal(bRow.inheritedType?.modelId, 'b');
  assert.equal(bRow.inheritedType?.psets[0].properties.Thickness, '0.25 m');
});

test('#7104 inherited values and sets are bounded while their full counts remain explicit', async () => {
  seedModel('arch', 0, await sample(), 52);
  assert.ok(getOrCreateMutationView(useViewerStore, 'arch'));
  const state = useViewerStore.getState();
  for (let i = 0; i < 20; i++) assert.ok(state.createPropertySet('arch', 50, `Extra ${i}`,
    Array.from({ length: 40 }, (_, j) => ({ name: `Property ${j}`, value: j === 0 ? 'x'.repeat(300) : 'short', type: PropertyValueType.Label }))));
  const type = inherited();
  assert.equal(type.psetCount, 21);
  assert.equal(type.psets.length, 16);
  assert.equal(type.psets[1].propertyCount, 40);
  assert.equal(Object.keys(type.psets[1].properties).length, 32);
  assert.equal(type.psets[1].properties['Property 0'].length, 241);
});

test('#7104 the first edited property set on a previously empty real type is inherited', async () => {
  seedModel('arch', 0, await sample(), 262);
  assert.equal(inherited().psetCount, 0, 'real SketchUp wall type #260 has no HasPropertySets');
  assert.ok(getOrCreateMutationView(useViewerStore, 'arch'));
  assert.ok(useViewerStore.getState().createPropertySet('arch', 260, 'First Type Set',
    [{ name: 'FireRating', value: 'REI30', type: PropertyValueType.Label }]));
  assert.equal(inherited().GlobalId, '2YJwrhcCv9v8UXU8cWK40m');
  assert.equal(inherited().psets[0].properties.FireRating, 'REI30');
});


test('#7104 source-free native property tables retain the real IFC type definition', async () => {
  const store = await sample();
  const loaded = extractTypePropertiesOnDemand(store, 52); assert.ok(loaded);
  const builder = new PropertyTableBuilder(new StringTable());
  for (const pset of loaded.properties) for (const property of pset.properties) {
    assert.equal(typeof property.value, 'string', 'the real slab type carries label values');
    builder.add({ entityId: loaded.typeId, psetName: pset.name, psetGlobalId: pset.globalId ?? '',
      propName: property.name, propType: property.type, value: String(property.value) });
  }
  seedModel('server', 0, { ...store, source: new Uint8Array(), properties: builder.build() }, 52);
  assert.equal(inherited().psets[0].properties.FireRating, 'REI60');
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  const triggers = [...ui.querySelectorAll('button')].filter(button => button.textContent?.includes('Pset_SlabCommon'));
  assert.ok(triggers.length);
  for (const trigger of triggers) if (trigger.getAttribute('data-state') !== 'open') click(trigger);
  await advance(0);
  assert.ok(ui.querySelector('[data-prop-key="50:Pset_SlabCommon:FireRating"]'));
  assert.match(ui.textContent ?? '', /REI60/);
});

test('#7104 an overlay occurrence alias inherits its real source type without a parsed occurrence ID', async () => {
  seedModel('arch', 1_000_000, await sample(), 52);
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  // Native duplication uses these overlay primitives: a new occurrence plus
  // its source alias. The inherited reader must follow the alias, not source ids.
  view.setExpressIdWatermark(100_000); // the fixture model's allocation watermark
  const copy = view.createEntity('IfcSlab', ['0hnSKr4LD8eRixcnqcc6X2', null, 'Copy', null, null, null, null, null, null]);
  view.setEntityAlias(copy.expressId, 52);
  assert.equal(useViewerStore.getState().models.get('arch')?.ifcDataStore?.entityIndex.byId.has(copy.expressId), false);
  useViewerStore.setState({ selectedEntity: { modelId: 'arch', expressId: copy.expressId }, selectedEntityId: copy.expressId + 1_000_000 });
  assert.equal(inherited().GlobalId, '0hnSKr4LD8eRixcnqcc6X1');
  assert.equal(inherited().psets[0].properties.FireRating, 'REI60');
});

test('#7104 clearing the associated type Name with the IFC unset marker never exposes a literal dollar', async () => {
  seedModel('arch', 0, await sample(), 52);
  assert.ok(getOrCreateMutationView(useViewerStore, 'arch'));
  assert.ok(useViewerStore.getState().setAttribute('arch', 50, 'Name', '$', 'house - groundfloor'));
  assert.equal(inherited().Name, '');
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  assert.ok(ui.querySelector('[title="IfcSlabType: "]'), 'the real associated-type header renders a cleared name');
  assert.ok(![...ui.querySelectorAll('[title]')].some(element => element.getAttribute('title') === 'IfcSlabType: $'));
});
