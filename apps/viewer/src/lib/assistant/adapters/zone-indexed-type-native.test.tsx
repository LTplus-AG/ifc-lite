/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { EMPTY_SOURCE_BYTES, extractTypeQuantitiesOnDemand, readCurrentTypeQuantities } from '@ifc-lite/parser';
import { iterateEffectiveEntities, type IfcAttributeValue } from '@ifc-lite/data';
import { StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { useViewerStore } from '@/store';
import { inheritedSource, parse, net } from '@/test/inherited-quantities-native-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original, true));

// #7220: materialize actual parsed native fields before releasing source. Only
// schema reference slots become #id tokens; quantity values remain scalars.
async function sourceFreeFixture(t: Parameters<typeof inheritedSource>[0]) {
  const x = await inheritedSource(t); if (!x) return;
  const oracle = await parse(editedModelBytes(x.store, x.view));
  assert.equal(net(extractTypeQuantitiesOnDemand(oracle, x.f.id)?.quantities ?? []), 10);
  const nativeQto = oracle.getEntity(x.a.qto); assert.ok(nativeQto);
  assert.equal(nativeQto.type.toUpperCase(), 'IFCELEMENTQUANTITY');
  assert.equal(x.store.entities.getTypeName(x.a.qto), 'Unknown',
    'real parsed resource lacks entity-table type: this is the indexed-type coverage witness');
  assert.equal((x.store.entityIndex.byId.get(x.a.qto) ?? x.store.deferredEntityIndex?.get(x.a.qto))?.type.toUpperCase(), 'IFCELEMENTQUANTITY',
    'the real retained native index independently records its type');
  const slots = new Map<number, ReadonlySet<number>>([
    [x.a.type, new Set([1, 5, 6])], [x.a.qto, new Set([1, 5])], [x.a.volume, new Set([2])],
    [x.b.type, new Set([1, 5, 6])], [x.b.qto, new Set([1, 5])], [x.b.volume, new Set([2])],
  ]);
  for (const row of iterateEffectiveEntities(x.store, undefined, ['IfcRelDefinesByType', 'IfcRelDefinesByProperties'])) {
    assert.ok(slots.size < 20000, 'actual closed native relationship inventory is bounded');
    slots.set(row.expressId, new Set([1, 4, 5]));
  }
  const reference = (value: unknown): IfcAttributeValue => {
    if (value === null || value === '*') return value;
    if (Array.isArray(value)) return value.map(reference);
    assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && x.store.getEntity(value));
    return `#${value}`;
  };
  for (const [id, references] of slots) {
    const entity = x.store.getEntity(id); assert.ok(entity);
    entity.attributes.forEach((value, index) => x.view.setPositionalAttribute(id, index,
      references.has(index) ? reference(value) : value));
  }
  // No accessor replacement: the original closure remains, but source-free
  // production must consume only retained type indexes and actual view fields.
  const sourceFree = { ...x.store, source: EMPTY_SOURCE_BYTES };
  return { ...x, sourceFree, nativeQto };
}

test('#7220 current inherited metadata reads native indexed resource type after source release', async t => {
  const x = await sourceFreeFixture(t); if (!x) return;
  const revision = x.view.getMutationRevision();
  const changes = x.view.getEffectiveChanges();
  const read = readCurrentTypeQuantities(x.sourceFree, x.f.id, x.view);
  const current = read.value;
  assert.equal(read.status, 'available', 'complete actual current native fields and retained indexed type stay readable');
  assert.ok(current, 'complete native current fields plus retained indexed type remain readable');
  assert.equal(net(current.quantities), 10, 'public read agrees with independently exported native oracle');
  assert.equal(x.view.getMutationRevision(), revision);
  assert.deepEqual(x.view.getEffectiveChanges(), changes, 'read performs no native writes');
});

test('#7220 actual current retyped definition overrides retained native indexed type', async t => {
  const x = await sourceFreeFixture(t); if (!x) return;
  x.view.setEntityType(x.a.qto, 'IfcPropertySet');
  const revision = x.view.getMutationRevision();
  const read = readCurrentTypeQuantities(x.sourceFree, x.f.id, x.view);
  const current = read.value;
  assert.equal(read.status, 'available');
  assert.equal(current, null, 'current non-quantity definition cannot resurrect the indexed quantity type');
  assert.equal(x.view.getMutationRevision(), revision);
});

test('#7220 indexed type alone cannot fabricate source-free quantity attributes', async t => {
  const x = await inheritedSource(t); if (!x) return;
  const oracle = await parse(editedModelBytes(x.store, x.view));
  assert.equal(net(extractTypeQuantitiesOnDemand(oracle, x.f.id)?.quantities ?? []), 10);
  const sourceFree = { ...x.store, source: EMPTY_SOURCE_BYTES };
  const revision = x.view.getMutationRevision();
  const read = readCurrentTypeQuantities(sourceFree, x.f.id, x.view);
  assert.equal(read.status, 'unavailable', 'source-free indexed types without supplied native attributes remain unavailable');
  assert.ok(read.reason);
  assert.equal(read.value, null);
  assert.equal(x.view.getMutationRevision(), revision);
});

test('#7220 actual created type metadata wins after source release', async t => {
  const x = await sourceFreeFixture(t); if (!x) return;
  const attrs = x.store.getEntity(x.b.type)?.attributes; assert.ok(attrs);
  const editor = new StoreEditor(x.store, x.view);
  const owner = typeof attrs[1] === 'number' ? `#${attrs[1]}` : null;
  const volume = editor.addEntity('IfcQuantityVolume', x.store.schemaVersion === 'IFC2X3'
    ? ['NetVolume', null, null, 30] : ['NetVolume', null, null, 30, null]);
  const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner,
    'Qto_CreatedIndexedTypeControl', null, null, [`#${volume.expressId}`]]);
  const created = editor.addEntity('IfcWallType', [
    generateIfcGuid(), owner,
    'Current created native type', attrs[3], attrs[4], [`#${qto.expressId}`], null, attrs[7], attrs[8], attrs[9],
  ]);
  x.view.setPositionalAttribute(x.relation, 5, `#${created.expressId}`);
  const exported = await parse(editedModelBytes(x.store, x.view));
  assert.equal(exported.getEntity(x.relation)?.attributes[5], created.expressId,
    'independent native export assigns the genuinely created type');
  assert.equal(net(extractTypeQuantitiesOnDemand(exported, x.f.id)?.quantities ?? []), 30,
    'independent native oracle proves the created type second quantity definition');
  const revision = x.view.getMutationRevision();
  const read = readCurrentTypeQuantities(x.sourceFree, x.f.id, x.view);
  const current = read.value;
  assert.equal(read.status, 'available');
  assert.ok(current, 'current created type does not need a retained source index row');
  assert.equal(current.typeId, created.expressId);
  assert.equal(net(current.quantities), 30, 'created ownership reads the independently authored native second definition');
  assert.equal(x.view.getMutationRevision(), revision);
});
