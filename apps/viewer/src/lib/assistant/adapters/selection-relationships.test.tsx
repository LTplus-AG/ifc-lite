/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { advance, render, cleanup } from '@/test/render';
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
});
