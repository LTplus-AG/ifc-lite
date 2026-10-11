/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { extractProjectUnits, extractTypeQuantitiesOnDemand } from '@ifc-lite/parser';
import * as nativeParser from '@ifc-lite/parser';
import { StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { cleanup } from '@/test/render';
import { setGlobalRendererRef } from '@/hooks/useBCF';

// #7353 published API contract: the native reader must be exported and execute
// the exact status/reason scenarios below. Namespace access survives complete
// production rollback, where absent exported capability is an assertion failure.
function readCurrentTypeQuantities(...args: Parameters<typeof nativeParser.readCurrentTypeQuantities>) {
 assert.equal(typeof nativeParser.readCurrentTypeQuantities, 'function', '#7353 exports the current native type-quantity reader');
 return nativeParser.readCurrentTypeQuantities(...args);
}
function readCurrentProjectUnits(...args: Parameters<typeof nativeParser.readCurrentProjectUnits>) {
 assert.equal(typeof nativeParser.readCurrentProjectUnits, 'function', '#7353 exports the current native project-unit reader');
 return nativeParser.readCurrentProjectUnits(...args);
}

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });
import { inheritedSource, parse, net } from '@/test/inherited-quantities-native-fixture';

for (const kind of ['oversized', 'unsupported', 'malformed-value', 'negative-volume'] as const) {
 test(`#7353 ${kind} native type quantities preserve own bases with explicit unavailable coverage`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { f, store, view } = fixture;
  await prepareQuantityRefusal(fixture, kind);
  const revision = view.getMutationRevision();
  const result = readCurrentTypeQuantities(store, f.id, view);
  assert.equal(result.status, 'unavailable'); assert.equal(result.value, null);
  assert.ok(result.reason, 'unavailable coverage has an explicit reason');
  assert.equal(extractTypeQuantitiesOnDemand(store, f.id, view), null, 'nullable current API does not fall back to original source10');
  assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id)?.quantities ?? []), 10, 'source-only control remains the original snapshot');
  assert.equal(view.getMutationRevision(), revision, 'refused current capture and mounted card remain read-only');
 });
}

// #7353: the quantity's explicit Unit is a current native dependency too.
test('#7353 current inherited quantity explicit Unit scale agrees with native export', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, a } = fixture;
 const { source, current, readScale, nativeScale } = await prepareExplicitQuantityUnit(fixture);
 const actual = readScale(source, current);
 const coverage = readCurrentTypeQuantities(source, f.id, current);
 assert.equal(coverage.status, 'available');
 assert.ok(coverage.value);
 assert.equal(net(coverage.value.quantities), 10);
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
 const currentContext = readCurrentProjectUnits(store, view);
 assert.equal(currentContext.status, 'available');
 assert.deepEqual(currentContext.value?.resolvedForUnitType('VOLUMEUNIT'), nativeUnits.resolvedForUnitType('VOLUMEUNIT'));
 assert.equal(extractTypeQuantitiesOnDemand(store, f.id, view)?.quantities[0]?.quantities[0]?.explicitUnitSiScale, undefined,
  'an implicit unit remains implicit; current project context is separate');
});

test('#7353 current project unit assignment follows newly allocated native context and preserves own basis', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { store, view } = fixture;
 const { nativeUnits } = await prepareNewProjectContext(fixture);
 assert.deepEqual(readCurrentProjectUnits(store, view).value?.resolvedForUnitType('VOLUMEUNIT'), nativeUnits.resolvedForUnitType('VOLUMEUNIT'));
 assert.equal(extractProjectUnits(store.source, store.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.symbol, 'm³',
  'source-only project defaults remain unchanged');
});

for (const kind of ['unset-context', 'deleted-project', 'deleted-assignment', 'unsupported-unit', 'empty-assignment', 'cyclic-unit', 'oversized-dependencies'] as const) {
 test(`#7353 ${kind} current project context reports unknown instead of a false own quantity basis`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { store, view } = fixture;
  await prepareProjectRefusal(fixture, kind);
  const revision = view.getMutationRevision();
  const current = readCurrentProjectUnits(store, view);
  assert.equal(current.status, 'unavailable'); assert.equal(current.value, null); assert.ok(current.reason);
  if (kind === 'oversized-dependencies') assert.match(current.reason, /read limit/);
  if (kind === 'cyclic-unit') assert.match(current.reason, /unresolved or unsupported/,
   'active cycle refusal precedes read-budget exhaustion or stack overflow');
  assert.equal(view.getMutationRevision(), revision, 'context capture and mounted refusal remain read-only');
 });
}

for (const kind of ['deleted', 'unsupported', 'cyclic', 'oversized'] as const) {
 test(`#7353 ${kind} native quantity Unit dependency refuses unknown coverage without crashing the card`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { f, store, view } = await prepareQuantityUnitRefusal(fixture, kind);
  const revision = view.getMutationRevision();
  const result = readCurrentTypeQuantities(store, f.id, view);
  assert.equal(result.status, 'unavailable'); assert.equal(result.value, null); assert.ok(result.reason);
  if (kind === 'oversized') assert.match(result.reason, /read limit/);
  if (kind === 'cyclic') assert.match(result.reason, /unresolved or unsupported/, 'active cycle refusal precedes work-budget exhaustion or stack overflow');
  assert.equal(extractTypeQuantitiesOnDemand(store, f.id, view), null, 'unknown units cannot use a stale source scale or default SI');
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
  const current = readCurrentTypeQuantities(store, f.id, view);
  assert.equal(current.status, 'unavailable', 'malformed native ownership cannot certify empty inherited facts');
  assert.equal(current.value, null); assert.ok(current.reason);
 });
}

for (const members of [null, []] as const) {
 test(`#7353 ${members === null ? 'null' : 'empty'} required native IfcElementQuantity.Quantities reports unavailable`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { f, store, a, view } = fixture;
  view.setPositionalAttribute(a.qto, 5, members === null ? null : []);
  const exported = await parse(editedModelBytes(store, view));
  assert.deepEqual(exported.getEntity(a.qto)?.attributes[5], members, 'independent native export contains the malformed required collection');
  const current = readCurrentTypeQuantities(store, f.id, view);
  assert.equal(current.status, 'unavailable', 'malformed required quantity members cannot certify empty inherited facts');
  assert.equal(current.value, null); assert.ok(current.reason);
 });
}
test('#7353 empty required native IfcRelDefinesByType.RelatedObjects reports unavailable', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, relation, view } = fixture;
 view.setPositionalAttribute(relation, 4, []);
 assert.deepEqual((await parse(editedModelBytes(store, view))).getEntity(relation)?.attributes[4], []);
 assert.equal(readCurrentTypeQuantities(store, f.id, view).status, 'unavailable');
});
test('#7353 optional native IfcTypeObject.HasPropertySets null remains verified empty coverage', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, a, view } = fixture;
 view.setPositionalAttribute(a.type, 5, null);
 const exported = await parse(editedModelBytes(store, view));
 assert.equal(exported.getEntity(a.type)?.attributes[5], null);
 assert.equal(net(extractTypeQuantitiesOnDemand(exported, f.id)?.quantities ?? []), undefined);
 const current = readCurrentTypeQuantities(store, f.id, view);
 assert.equal(current.status, 'available'); assert.equal(current.value, null);
});

import { prepareExplicitQuantityUnit, prepareQuantityRefusal, prepareProjectRefusal, prepareQuantityUnitRefusal, prepareNewProjectContext, prepareImplicitProjectUnit } from '@/test/inherited-quantities-native-fixture';
