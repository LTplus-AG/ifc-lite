/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { extractProjectUnits, extractTypeQuantitiesOnDemand, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { IfcQuery } from '@ifc-lite/query';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { RelationshipType, QuantityType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { effectiveElementData } from '@/components/viewer/properties/effectiveElementData';
import { withInheritedTypeQuantities } from '@/lib/zones/inherited-quantities';
import { ZoneVolumeBreakdown } from '@/components/viewer/ZoneVolumeBreakdown';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { render, cleanup } from '@/test/render';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });
import { inheritedSource, parse, net, native } from '@/test/inherited-quantities-native-fixture';

test('#7353 canonical inherited quantity card follows native edits and type reassignment', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, a, b, relation, view } = fixture;
 const read = () => {
  const own = effectiveElementData(f.id, new IfcQuery(store), view).qsets;
  assert.equal(own.length, 0, 'source preparation leaves type-only quantities');
  const canonical = withInheritedTypeQuantities(own, store, f.id, RelationshipType.DefinesByType, (s, id) => extractTypeQuantitiesOnDemand(s as IfcDataStore, id, view)?.quantities);
  return { canonical };
 };
 assert.equal(net(read().canonical), 10);
 view.setPositionalAttribute(a.volume, 3, 20);
 assert.equal(await native(store, view, f.id), 20, 'independent export/reparse sees current type quantity edit');
 let result = read();
 const editedQuantity = net(result.canonical);
 const ui = render(<ZoneVolumeBreakdown zoneSet={f.zoneSet} globalId={f.id} quantitySets={result.canonical} projectUnits={extractProjectUnits(store.source, store.entityIndex)} unitDisplayOverrides={{}} />);
 assert.ok(ui.textContent?.includes('net'), 'mount actual native Properties card on its canonical quantity input');
 console.log('NATIVE_TYPE_QUANTITY_EDIT', JSON.stringify({ native: 20, canonicalCardInput: net(result.canonical), cardText: ui.textContent })); cleanup();
 const panel = render(<PropertiesPanel />);
 assert.match(panel.textContent ?? '', /netNetVolume20 m³/, 'actual Properties panel passes the current native view to its inherited quantity card');
 cleanup();
 view.setPositionalAttribute(relation, 5, `#${b.type}`);
 assert.equal(await native(store, view, f.id), 30, 'independent export/reparse follows the new native type');
 result = read(); const reassignedQuantity = net(result.canonical);
 assert.deepEqual({ editedQuantity, reassignedQuantity }, { editedQuantity: 20, reassignedQuantity: 30 }, 'canonical card must agree with both independently reparsed native exports');
 console.log('TYPE_REASSIGN', JSON.stringify({ native: 30, canonicalCardInput: net(result.canonical) }));
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id)?.quantities ?? []), 10, 'source-only API retains the original native snapshot');
 const journalBefore = editedModelBytes(store, view);
 if (process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT) await writeFile(process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT + '.before.ifc', journalBefore);
 const revision = view.getMutationRevision();
 const beforeRead = useViewerStore.getState().mutationVersion;
 view.setQuantity(b.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume, undefined, true);
 assert.ok(view.getMutationRevision() > revision);
 assert.equal(useViewerStore.getState().mutationVersion, beforeRead, 'direct native edits need not publish a viewer notification');
 const journalExport = editedModelBytes(store, view);
 const journalStore = await parse(journalExport);
 const nativeSets = extractTypeQuantitiesOnDemand(journalStore, f.id)?.quantities ?? [];
 console.log('NATIVE_TYPE_JOURNAL_INVENTORY', JSON.stringify(nativeSets));
 if (process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT) await writeFile(process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT, journalExport);
 await assertSameNativeIfcGraph(journalExport, journalBefore, 'the current native writer ignores this type-owned quantity journal write (#7355 counterexample)');
 assert.equal(net(nativeSets), 30, 'native HasPropertySets remains first after a type quantity journal write');
 const source = store.source.materialize().slice();
 const readRevision = view.getMutationRevision();
 const readJournal = view.getMutations();
 assert.equal(net(read().canonical), 30, 'canonical reader must retain independently reparsed native basis precedence');
 assert.equal(view.getMutationRevision(), readRevision, 'current extraction remains read-only');
 assert.deepEqual(view.getMutations(), readJournal, 'current extraction preserves native journal');
 assert.deepEqual(store.source.materialize(), source, 'current extraction preserves source bytes');
 useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
 const deletedView = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(deletedView);
 deletedView.deleteEntity(a.volume);
 assert.equal(await native(store, deletedView, f.id), undefined, 'native export drops an empty type quantity set');
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, deletedView)?.quantities ?? []), undefined, 'deleted native quantities cannot be resurrected');
 useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
 const detachedView = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(detachedView);
 detachedView.deleteEntity(relation);
 assert.equal(await native(store, detachedView, f.id), undefined, 'native export has no type after relationship deletion');
 assert.equal(extractTypeQuantitiesOnDemand(store, f.id, detachedView), null, 'deleted type assignments cannot be resurrected');
 const independentView = new MutablePropertyView(store.properties, 'independent-native-model');
 independentView.setAttribute(a.volume, 'VolumeValue', '70');
 assert.equal(await native(store, independentView, f.id), 70, 'independent native model view exports its named edit');
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, independentView)?.quantities ?? []), 70, 'shared source does not share another view quantity cache');
 independentView.setPositionalAttribute(a.volume, 3, 80);
 assert.equal(await native(store, independentView, f.id), 80);
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, independentView)?.quantities ?? []), 80, 'positional precedence and direct revision invalidate the memo');
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, view)?.quantities ?? []), 30, 'the original model view retains its current native basis');



});


for (const kind of ['oversized', 'unsupported', 'malformed-value', 'negative-volume'] as const) {
 test(`#7353 ${kind} native type quantities preserve own bases with explicit unavailable coverage`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { f, store, a, view } = fixture;
  await prepareQuantityRefusal(fixture, kind);
  const revision = view.getMutationRevision();
  assert.equal(extractTypeQuantitiesOnDemand(store, f.id, view), null, 'nullable current API does not fall back to original source10');
  assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id)?.quantities ?? []), 10, 'source-only control remains the original snapshot');
  const panel = render(<PropertiesPanel />);
  assert.match(panel.textContent ?? '', /Inherited type quantities are unavailable/);
  assert.match(panel.textContent ?? '', /netNetVolume25 m³/, 'unknown inherited coverage preserves the known native occurrence basis');
  assert.doesNotMatch(panel.textContent ?? '', /netNetVolume10 m³/, 'current refusal must not resurrect the source type basis');
  assert.equal(view.getMutationRevision(), revision, 'refused current capture and mounted card remain read-only');
 });
}

// #7353: the quantity's explicit Unit is a current native dependency too.
test('#7353 current inherited quantity explicit Unit scale agrees with native export', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { a } = fixture;
 const { source, current, readScale, nativeScale } = await prepareExplicitQuantityUnit(fixture);
 const actual = readScale(source, current);
 console.log('NATIVE_TYPE_QUANTITY_UNIT_EDIT', JSON.stringify({ nativeScale, currentScale: actual }));
 assert.equal(actual, nativeScale, 'current inherited quantity unit scale must agree with independently reparsed native IFC');
 const created = new StoreEditor(source, current).addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.CENTI.', '.CUBIC_METRE.']).expressId;
 current.setPositionalAttribute(a.volume, 2, `#${created}`);
 const reassigned = readScale(await parse(editedModelBytes(source, current)));
 assert.ok(reassigned !== undefined && Math.abs(reassigned / 1e-6 - 1) <= Number.EPSILON * 2,
  'native cubic-centimetre scale differs from 1e-6 by at most two relative floating-point ulps');
 assert.equal(readScale(source, current), reassigned, 'current quantity Unit reassignment uses that native entity');
 assert.equal(readScale(source), 1, 'source-only unit semantics retain the original snapshot');
});

test('#7353 current inherited quantity implicit project Unit agrees with native export', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, view } = fixture;
 const { nativeUnits } = await prepareImplicitProjectUnit(fixture);
 assert.equal(extractTypeQuantitiesOnDemand(store, f.id, view)?.quantities[0]?.quantities[0]?.explicitUnitSiScale, undefined,
  'an implicit unit remains implicit; current project context is separate');
 const panel = render(<PropertiesPanel />);
 console.log('NATIVE_IMPLICIT_QUANTITY_UNIT', JSON.stringify({ nativeUnit: nativeUnits.resolvedForUnitType('VOLUMEUNIT'), cardText: panel.textContent }));
 assert.match(panel.textContent ?? '', /NetVolume10 mm³/,
  'mounted current card must agree with the native inherited project unit instead of presenting10 cubic metres');
});

test('#7353 current project unit assignment follows newly allocated native context and preserves own basis', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, view } = fixture;
 const { nativeUnits } = await prepareNewProjectContext(fixture);
 const panel = render(<PropertiesPanel />);
 assert.match(panel.textContent ?? '', /netNetVolume25 cm³/, 'own implicit basis uses the current native context');
 assert.doesNotMatch(panel.textContent ?? '', /netNetVolume25 m³/);
 assert.equal(extractProjectUnits(store.source, store.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.symbol, 'm³',
  'source-only project defaults remain unchanged');
});

for (const kind of ['unset-context', 'deleted-project', 'deleted-assignment', 'unsupported-unit', 'empty-assignment', 'cyclic-unit', 'oversized-dependencies'] as const) {
 test(`#7353 ${kind} current project context reports unknown instead of a false own quantity basis`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { f, store, view } = fixture;
  await prepareProjectRefusal(fixture, kind);
  const revision = view.getMutationRevision();
  const panel = render(<PropertiesPanel />);
  assert.match(panel.textContent ?? '', /Current quantity units are unavailable/);
  assert.doesNotMatch(panel.textContent ?? '', /netNetVolume25 m³/, 'unknown current units cannot fabricate a25-cubic-metre own basis');
  assert.doesNotMatch(panel.textContent ?? '', /netNetVolume10 m³/, 'unknown context cannot resurrect the source inherited physical basis');
  assert.equal(view.getMutationRevision(), revision, 'context capture and mounted refusal remain read-only');
 });
}

for (const kind of ['deleted', 'unsupported', 'cyclic', 'oversized'] as const) {
 test(`#7353 ${kind} native quantity Unit dependency refuses unknown coverage without crashing the card`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { f, store, a, view } = fixture;
  await prepareQuantityUnitRefusal(fixture, kind);
  const revision = view.getMutationRevision();
  assert.equal(extractTypeQuantitiesOnDemand(store, f.id, view), null, 'unknown units cannot use a stale source scale or default SI');
  const panel = render(<PropertiesPanel />);
  assert.match(panel.textContent ?? '', /Inherited type quantities are unavailable/);
  assert.match(panel.textContent ?? '', /netNetVolume25 m³/);
  assert.doesNotMatch(panel.textContent ?? '', /netNetVolume10 m³/);
  assert.equal(view.getMutationRevision(), revision, 'bounded refusal and mounted card are read-only');
 });
}

for (const field of ['RelatingType', 'RelatedObjects'] as const) {
 test(`#7353 null required native IfcRelDefinesByType.${field} reports unavailable inherited coverage`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { f, store, relation, view } = fixture;
  const slot = field === 'RelatingType' ? 5 : 4;
  view.setPositionalAttribute(relation, slot, null);
  const exported = await parse(editedModelBytes(store, view));
  assert.equal(exported.getEntity(relation)?.attributes[slot], null, 'independent native export contains the malformed required field');
  assert.equal(net(extractTypeQuantitiesOnDemand(exported, f.id)?.quantities ?? []), undefined,
   'saved source has no verified inherited quantity assignment');
  const panel = render(<PropertiesPanel />);
  assert.match(panel.textContent ?? '', /Inherited type quantities are unavailable/);
  assert.doesNotMatch(panel.textContent ?? '', /netNetVolume10 m³/, 'malformed current ownership cannot resurrect the immutable source basis');
 });
}

for (const members of [null, []] as const) {
 test(`#7353 ${members === null ? 'null' : 'empty'} required native IfcElementQuantity.Quantities reports unavailable`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { f, store, a, view } = fixture;
  view.setPositionalAttribute(a.qto, 5, members === null ? null : []);
  const exported = await parse(editedModelBytes(store, view));
  assert.deepEqual(exported.getEntity(a.qto)?.attributes[5], members, 'independent native export contains the malformed required collection');
  assert.match(render(<PropertiesPanel />).textContent ?? '', /Inherited type quantities are unavailable/);
 });
}
test('#7353 empty required native IfcRelDefinesByType.RelatedObjects reports unavailable', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, relation, view } = fixture;
 view.setPositionalAttribute(relation, 4, []);
 assert.deepEqual((await parse(editedModelBytes(store, view))).getEntity(relation)?.attributes[4], []);
 assert.match(render(<PropertiesPanel />).textContent ?? '', /Inherited type quantities are unavailable/);
});
test('#7353 optional native IfcTypeObject.HasPropertySets null remains verified empty coverage', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, a, view } = fixture;
 view.setPositionalAttribute(a.type, 5, null);
 const exported = await parse(editedModelBytes(store, view));
 assert.equal(exported.getEntity(a.type)?.attributes[5], null);
 assert.equal(net(extractTypeQuantitiesOnDemand(exported, f.id)?.quantities ?? []), undefined);
 const panel = render(<PropertiesPanel />);
 assert.doesNotMatch(panel.textContent ?? '', /Inherited type quantities are unavailable/);
 assert.doesNotMatch(panel.textContent ?? '', /netNetVolume10 m³/);
});

import { prepareExplicitQuantityUnit, prepareQuantityRefusal, prepareProjectRefusal, prepareQuantityUnitRefusal, prepareNewProjectContext, prepareImplicitProjectUnit } from '@/test/inherited-quantities-native-fixture';
