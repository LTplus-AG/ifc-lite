/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EMPTY_SOURCE_BYTES, effectiveStoreyId as parsedStoreyId, extractRelationshipsOnDemand } from '@ifc-lite/parser';
import { effectiveStoreyId } from '../../../../../../packages/create/src/in-store/edit/effective-storey';
import { advance, render, cleanup, click } from '@/test/render';
import { exportAndReparse, parseStep, seedModel } from '@/test/properties-panel-harness';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import { relationshipsForSelection } from '@/components/viewer/properties/merge-relationship-data';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { entityRefToString } from '@/store/entity-ref';
import { useViewerStore } from '@/store';
import { captureEvidence } from '../evidence';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
const sample = async () => parseStep(await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8'));
interface Edge { relationshipId: number; relationshipType: string; direction: 'forward' | 'inverse';
  verification: string; entity: { modelId: string; expressId: number; Name: string | null; type: string | null } }
interface Row { modelId: string; relationshipStatus: string; relationshipCount: number | null; relationships: Edge[] }
const rows = (): Row[] => JSON.parse(captureEvidence('selection').payload).evidence.rows.map((row: { data: Row }) => row.data);
const native = (modelId: string, expressId: number) => relationshipsForSelection(
  createQueryAdapter(useViewerStore).relationships, { modelId, expressId }, expressId);

// #7179 actual SketchUp space carries source record #81 to zone #80 and #97
// to storey #43. The derived groups array overlaps the exact edge population.
test('#7179 real SketchUp selected relationship evidence preserves exact native edge identity', async () => {
  const store = await sample(); seedModel('sketchup', 0, store, 89);
  const current = native('sketchup', 89);
  assert.equal(current.relations?.length, 6); assert.equal(current.groups.length, 1);
  assert.deepEqual(current.relations?.filter(edge => [81, 97].includes(edge.relationshipId))
    .map(edge => [edge.relationshipId, edge.relationshipType, edge.direction, edge.entity.id]),
  [[81, 'IfcRelAssignsToGroup', 'inverse', 80], [97, 'IfcRelAggregates', 'inverse', 43]]);
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  assert.match(ui.textContent ?? '', /Relationships/); cleanup();
  const row = rows()[0];
  assert.equal(row.relationshipStatus, 'available'); assert.equal(row.relationshipCount, 6);
  assert.deepEqual(row.relationships.filter(edge => [81, 97].includes(edge.relationshipId))
    .map(edge => [edge.relationshipId, edge.relationshipType, edge.direction, edge.entity.expressId]),
  [[81, 'IfcRelAssignsToGroup', 'inverse', 80], [97, 'IfcRelAggregates', 'inverse', 43]]);
});

// #7179 public writer references must describe the actual STEP endpoints;
// retargeting and deleting a source record change membership, not just labels.
test('#7179 source retarget and deletion match native exported relationship records', async () => {
  const store = await sample(); seedModel('edited', 0, store, 43);
  const view = getOrCreateMutationView(useViewerStore, 'edited'); assert.ok(view);
  view.setPositionalAttribute(97, 5, ['#52']);
  const file = await exportAndReparse('edited', store);
  assert.deepEqual(file.getEntity(97)?.attributes[5], [52]);
  const edited = rows()[0];
  const targetIds = native('edited', 43).relations?.filter(edge => edge.relationshipId === 97).map(edge => edge.entity.id);
  assert.deepEqual(targetIds, [52]);
  view.deleteEntity(97);
  const removed = await exportAndReparse('edited', store);
  assert.equal(removed.entityIndex.byId.has(97), false);
  assert.ok(!native('edited', 43).relations?.some(edge => edge.relationshipId === 97));
  assert.ok(Array.isArray(edited.relationships), 'retargeted source relationships must be included');
  assert.deepEqual(edited.relationships.filter(edge => edge.relationshipId === 97).map(edge => edge.entity.expressId), [52]);
  assert.ok(!rows()[0].relationships.some(edge => edge.relationshipId === 97));
});

// #7179 independently parsed source IDs collide in federation; target edits
// belong to their actual model rather than to a shared numeric namespace.
test('#7179 native relationship target edits remain isolated across federated models', async () => {
  const a = await sample(), b = await sample(); seedModel('a', 0, a, 89);
  const first = useViewerStore.getState().models.get('a'); assert.ok(first);
  useViewerStore.setState({ models: new Map([['a', first], ['b', { ...first, id: 'b', name: 'b', idOffset: 1_000_000, ifcDataStore: b }]]) });
  const view = getOrCreateMutationView(useViewerStore, 'b'); assert.ok(view); view.setAttribute(80, 'Name', 'B ONLY');
  const file = await exportAndReparse('b', b); assert.equal(file.entities.getName(80), 'B ONLY');
  assert.equal(native('a', 89).relations?.find(edge => edge.relationshipId === 81)?.entity.name, 'house - living space');
  assert.equal(native('b', 89).relations?.find(edge => edge.relationshipId === 81)?.entity.name, 'B ONLY');
  useViewerStore.setState({ selectedEntitiesSet: new Set(['a', 'b'].map(modelId => entityRefToString({ modelId, expressId: 89 }))) });
  const selected = rows();
  assert.ok(selected.every(row => Array.isArray(row.relationships)), 'each model must carry native relationship evidence');
  assert.deepEqual(selected.map(row => [row.modelId, row.relationships.find(edge => edge.relationshipId === 81)?.entity.Name]),
    [['a', 'house - living space'], ['b', 'B ONLY']]);
});

// #7179 immutable graph rows can remain known source-origin evidence, but a
// source-empty edited relationship cannot prove a current full population.
test('#7179 source-free edited native relationship membership has an unknown total', async () => {
  const store = await sample(); assert.equal(store.getEntity(97)?.type, 'IFCRELAGGREGATES');
  store.source = EMPTY_SOURCE_BYTES; seedModel('wire', 0, store, 43);
  const view = getOrCreateMutationView(useViewerStore, 'wire'); assert.ok(view);
  view.setPositionalAttribute(97, 5, ['#52']);
  let sourceReads = 0;
  const originalGetter = store.getEntity;
  store.getEntity = expressId => {
    if (store.entityIndex.byId.get(expressId)?.type.startsWith('IFCREL')) {
      sourceReads++; throw new Error('source-free transport has no current STEP relationship records');
    }
    return originalGetter(expressId);
  };
  const row = rows()[0];
  assert.equal(sourceReads, 0);
  assert.equal(row.relationshipStatus, 'unavailable-source-membership');
  assert.equal(row.relationshipCount, null);
  assert.ok(row.relationships.some(edge => edge.verification === 'unverified'));
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  const trigger = [...ui.querySelectorAll('button')].find(button => button.textContent?.includes('Relationships'));
  assert.ok(trigger); assert.match(trigger.textContent ?? '', /\?/);
  if (!ui.textContent?.includes('Current relationship membership')) { click(trigger); await advance(0); }
  assert.match(ui.textContent ?? '', /Current relationship membership is unavailable/);
  assert.equal(sourceReads, 0);
});

// #7179 actual public authored assignment records must survive STEP export;
// native edge direction belongs to the selected endpoint, not the group name.
test('#7179 public authored relationship preserves native identity and both directions', async () => {
  const store = await sample(); seedModel('authored', 0, store, 52);
  const view = getOrCreateMutationView(useViewerStore, 'authored'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const group = view.createEntity('IfcGroup', ['0000000000000000000001', null, 'Authored group', null, null]);
  const association = view.createEntity('IfcRelAssignsToGroup', ['0000000000000000000002', null, null, null, ['#52'], null, `#${group.expressId}`]);
  const exported = await exportAndReparse('authored', store);
  assert.deepEqual(exported.getEntity(association.expressId)?.attributes[4], [52]);
  assert.equal(exported.getEntity(association.expressId)?.attributes[6], group.expressId);
  assert.deepEqual(native('authored', 52).relations?.filter(edge => edge.relationshipId === association.expressId)
    .map(edge => [edge.relationshipType, edge.direction, edge.entity.id]), [['IfcRelAssignsToGroup', 'inverse', group.expressId]]);
  assert.deepEqual(native('authored', group.expressId).relations?.filter(edge => edge.relationshipId === association.expressId)
    .map(edge => [edge.relationshipType, edge.direction, edge.entity.id]), [['IfcRelAssignsToGroup', 'forward', 52]]);
  const beforeDeletion = rows()[0];
  view.deleteEntity(association.expressId);
  const removed = await exportAndReparse('authored', store);
  assert.equal(removed.entityIndex.byId.has(association.expressId), false);
  assert.ok(!native('authored', 52).relations?.some(edge => edge.relationshipId === association.expressId));
  assert.ok(Array.isArray(beforeDeletion.relationships), 'authored assignment must appear in selected evidence');
  const inverse = beforeDeletion.relationships.find(edge => edge.relationshipId === association.expressId);
  assert.ok(inverse); assert.equal(inverse.direction, 'inverse'); assert.equal(inverse.relationshipType, 'IfcRelAssignsToGroup');
  assert.equal(inverse.entity.expressId, group.expressId);
  assert.ok(!rows()[0].relationships.some(edge => edge.relationshipId === association.expressId));
});

// #7179 fan-out is real exported IFC, rather than an invented evidence array.
test('#7179 native authored relationship fan-out retains full known count and bounded rows', async () => {
  const store = await sample(); seedModel('bounded', 0, store, 52);
  const view = getOrCreateMutationView(useViewerStore, 'bounded'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const baseline = native('bounded', 52).relations?.length ?? 0;
  const group = view.createEntity('IfcGroup', ['0000000000000000000001', null, 'x'.repeat(251), null, null]);
  const ids: number[] = [];
  for (let i = 0; i < 20; i++) {
    ids.push(view.createEntity('IfcRelAssignsToGroup', [`1${String(i).padStart(21, '0')}`, null, null, null, ['#52'], null, `#${group.expressId}`]).expressId);
  }
  const exported = await exportAndReparse('bounded', store);
  assert.equal(ids.filter(id => exported.entityIndex.byId.get(id)?.type === 'IFCRELASSIGNSTOGROUP').length, 20);
  assert.equal(native('bounded', 52).relations?.length, baseline + 20);
  const row = rows()[0]; assert.equal(row.relationshipCount, baseline + 20);
  assert.equal(row.relationships.length, 16);
  const sampledGroup = row.relationships.find(edge => edge.entity.expressId === group.expressId);
  assert.ok(sampledGroup); assert.equal(sampledGroup.entity.Name, `${'x'.repeat(240)}…`);
});

// #7179 the panel combines a native duplicate's base and direct relationships;
// one record targeting both is one selected edge, not two derived-array rows.
test('#7179 duplicate alias merges native base and direct relationship edges once', async () => {
  const store = await sample(); seedModel('duplicate', 0, store, 89);
  const view = getOrCreateMutationView(useViewerStore, 'duplicate'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const source = store.getEntity(89); assert.ok(source);
  const attributes = source.attributes.slice(); attributes[0] = '0000000000000000000001'; attributes[2] = 'Native duplicate';
  const duplicate = view.createEntity('IfcSpace', attributes); view.setEntityAlias(duplicate.expressId, 89);
  view.setPositionalAttribute(81, 4, ['#89', '#203', `#${duplicate.expressId}`]);
  const exported = await exportAndReparse('duplicate', store);
  assert.deepEqual(exported.getEntity(81)?.attributes[4], [89, 203, duplicate.expressId]);
  assert.equal(exported.entityIndex.byId.get(duplicate.expressId)?.type, 'IFCSPACE');
  const ref = { modelId: 'duplicate', expressId: duplicate.expressId };
  const combined = relationshipsForSelection(createQueryAdapter(useViewerStore).relationships, ref, view.resolveBaseEntityId(duplicate.expressId));
  assert.equal(combined.relations?.filter(edge => edge.relationshipId === 81 && edge.entity.id === 80).length, 1);
  assert.ok(combined.relations?.some(edge => edge.relationshipId === 97 && edge.entity.id === 43));
  useViewerStore.setState({ selectedEntity: ref, selectedEntityId: duplicate.expressId, selectedEntitiesSet: new Set([entityRefToString(ref)]) });
  const row = rows()[0];
  assert.equal(row.relationshipCount, combined.relations?.length);
  assert.equal(row.relationships.filter(edge => edge.relationshipId === 81 && edge.entity.expressId === 80).length, 1);
  assert.ok(row.relationships.some(edge => edge.relationshipId === 97 && edge.entity.expressId === 43));
});

// #7179 an omitted graph on a source-free transport proves no total at all.
test('#7179 source-free missing native relationship graph does not invent an empty population', async () => {
  const store = await sample(); seedModel('missing', 0, store, 89);
  assert.equal(native('missing', 89).relations?.length, 6);
  store.source = EMPTY_SOURCE_BYTES;
  const missing = { ...store }; Reflect.deleteProperty(missing, 'relationships');
  seedModel('missing', 0, missing, 89);
  const row = rows()[0];
  assert.equal(row.relationshipStatus, 'unavailable-membership');
  assert.equal(row.relationshipCount, null); assert.deepEqual(row.relationships, []);
});

// #7179 masking bytes must also prevent the old native graph from authorizing
// spatial edits through a superseded source relationship (not merely warn UI).
test('#7179 source-free retarget cannot authorize the original native storey membership', async () => {
  const store = await sample(); seedModel('authoring', 0, store, 89);
  const view = getOrCreateMutationView(useViewerStore, 'authoring'); assert.ok(view);
  assert.equal(effectiveStoreyId(store, view, 89), 43);
  view.setPositionalAttribute(97, 5, ['#52']);
  const exported = await exportAndReparse('authoring', store);
  assert.deepEqual(exported.getEntity(97)?.attributes[5], [52]);
  assert.equal(parsedStoreyId(exported, 89), undefined);
  store.source = EMPTY_SOURCE_BYTES;
  assert.equal(effectiveStoreyId(store, view, 89), undefined);
});

// #7179 fully authored native records remain usable without old source bytes.
test('#7179 complete authored spatial relationship survives opaque source membership edits', async () => {
  const store = await sample(); seedModel('complete', 0, store, 89);
  const view = getOrCreateMutationView(useViewerStore, 'complete'); assert.ok(view); view.setExpressIdWatermark(100_000);
  view.setPositionalAttribute(97, 5, ['#52']);
  const authored = view.createEntity('IfcRelAggregates', ['0000000000000000000001', null, null, null, '#43', ['#89']]);
  const exported = await exportAndReparse('complete', store);
  assert.deepEqual(exported.getEntity(97)?.attributes[5], [52]);
  assert.equal(exported.getEntity(authored.expressId)?.attributes[4], 43);
  assert.deepEqual(exported.getEntity(authored.expressId)?.attributes[5], [89]);
  assert.equal(parsedStoreyId(exported, 89), 43);
  store.source = EMPTY_SOURCE_BYTES;
  const original = store.getEntity; let sourceReads = 0;
  store.getEntity = id => {
    if (store.entityIndex.byId.get(id)?.type.startsWith('IFCREL')) { sourceReads++; throw new Error('opaque source relationship'); }
    return original(id);
  };
  assert.equal(effectiveStoreyId(store, view, 89), 43);
  const row = rows()[0]; assert.equal(row.relationshipCount, null);
  assert.ok(row.relationships.some(edge => edge.relationshipId === authored.expressId && edge.entity.expressId === 43));
  assert.equal(sourceReads, 0);
});

// #7179 the record and endpoint ID are known even when the target entity is
// missing; a native unresolved target must not disappear as verified absence.
test('#7179 native relationship evidence preserves graph-proved missing target IDs', async () => {
  const store = await sample(); seedModel('missing-target', 0, store, 43);
  const view = getOrCreateMutationView(useViewerStore, 'missing-target'); assert.ok(view);
  view.setPositionalAttribute(97, 5, ['#999999']);
  const exported = await exportAndReparse('missing-target', store);
  assert.deepEqual(exported.getEntity(97)?.attributes[5], [999999]);
  assert.equal(exported.getEntity(999999), null);
  assert.ok(extractRelationshipsOnDemand(exported, 43).relations?.some(edge => edge.relationshipId === 97 && edge.entity.id === 999999));
  const row = rows()[0];
  const unresolved = row.relationships.find(edge => edge.relationshipId === 97 && edge.entity.expressId === 999999);
  assert.ok(unresolved, 'known incident relationship must retain its unresolved target ID');
  assert.equal(unresolved.verification, 'unverified'); assert.equal(unresolved.entity.Name, null); assert.equal(unresolved.entity.type, null);
});

// #7179 real parsed column kinds remain authoritative when a transport loses
// an indexed source kind; current retyping cannot erase the original edge kind.
for (const boundary of ['missing', 'unknown', 'retyped'] as const) {
  test(`#7179 native authoring suppresses column-proved source relationship with ${boundary} index`, async () => {
    const store = await sample(); seedModel(boundary, 0, store, 89);
    assert.equal(store.entities.getTypeName(97), 'IfcRelAggregates');
    const view = getOrCreateMutationView(useViewerStore, boundary); assert.ok(view);
    if (boundary === 'retyped') view.setEntityType(97, 'IfcSlab');
    else view.setPositionalAttribute(97, 5, ['#52']);
    const exported = await exportAndReparse(boundary, store);
    assert.equal(parsedStoreyId(exported, 89), undefined);
    const indexed = store.entityIndex.byId.get(97); assert.ok(indexed);
    const transportedIndex = new Map(store.entityIndex.byId);
    if (boundary === 'unknown') transportedIndex.set(97, { ...indexed, type: 'Unknown' });
    else transportedIndex.delete(97);
    store.entityIndex.byId = transportedIndex;
    store.source = EMPTY_SOURCE_BYTES;
    assert.equal(store.entities.getTypeName(97), 'IfcRelAggregates');
    assert.equal(effectiveStoreyId(store, view, 89), undefined);
    assert.equal(rows()[0].relationshipCount, null);
  });
}

// #7179 the larger-selection limit is independent of native edge totals.
test('#7179 large actual native selection bounds each incident edge sample to six', async () => {
  const store = await sample(); seedModel('large', 0, store, 89);
  const view = getOrCreateMutationView(useViewerStore, 'large'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const baseline = native('large', 89).relations?.length ?? 0;
  const group = view.createEntity('IfcGroup', ['0000000000000000000001', null, 'Large selection group', null, null]);
  const ids: number[] = [];
  for (let i = 0; i < 20; i++) ids.push(view.createEntity('IfcRelAssignsToGroup', [`1${String(i).padStart(21, '0')}`, null, null, null, ['#89'], null, `#${group.expressId}`]).expressId);
  const exported = await exportAndReparse('large', store);
  assert.equal(ids.filter(id => exported.entityIndex.byId.get(id)?.type === 'IFCRELASSIGNSTOGROUP').length, 20);
  assert.equal(native('large', 89).relations?.length, baseline + 20);
  const selected = [89, ...Array.from(store.entities.expressId).filter(id => id !== 89).slice(0, 11)];
  assert.equal(selected.length, 12);
  useViewerStore.setState({ selectedEntitiesSet: new Set(selected.map(expressId => entityRefToString({ modelId: 'large', expressId }))) });
  const captured = rows(); assert.equal(captured.length, 12);
  assert.equal(captured[0].relationshipCount, baseline + 20); assert.equal(captured[0].relationships.length, 6);
});
