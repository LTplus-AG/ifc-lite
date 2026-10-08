/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { RelationshipType } from '@ifc-lite/data';
import { fixtureModels } from '@/test/store-fixture';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { ProfileSection } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { DEFAULT_SECTIONS, PROFILE_KINDS } from '@/lib/profile-section/profile-kinds';
import { changeOperations } from '@/lib/changes/change-operations';
import { inverseMutationTargets } from '@/store/slices/mutation-inverse-registry';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { AUTHORING_VERTEX_LIMIT } from './model-authoring-shape-params';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
import { authoringGhosts } from './model-authoring-ghost';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const batch = (operations: unknown[], units = 'm') => parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native shapes', units, frame: 'storey-local', operations }));
const create = (ifcClass: string, params: unknown, ref = 'shape') => ({ op: 'element.create', ref, ifcClass, storey: { globalId: GROUND_STOREY }, name: ref, params });

for (const units of ['m', 'mm']) test(`#7215 all seven native creation families and nine section variants export and undo in ${units}`, async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const factor = units === 'mm' ? 1000 : 1;
  const expected: Array<ProfileSection | null> = [];
  const operations: unknown[] = [];
  for (const ifcClass of ['IfcColumn', 'IfcBeam', 'IfcMember']) for (const kind of PROFILE_KINDS) {
    const section: ProfileSection = kind === 'Rectangle' ? { Type: 'Rectangle', XDim: .25, YDim: .4 } : DEFAULT_SECTIONS[kind];
    const scaled = Object.fromEntries(Object.entries(section).map(([key, value]) => [key, key === 'Type' ? value : Number(value) * factor]));
    operations.push(create(ifcClass, ifcClass === 'IfcColumn' ? { position: [0, 0, 0], height: 3 * factor, Profile: scaled }
      : { start: [0, 0, 3 * factor], end: [4 * factor, 0, 4 * factor], Profile: scaled }, `shape-${operations.length}`));
    expected.push(section);
  }
  for (const ifcClass of ['IfcSlab', 'IfcRoof', 'IfcPlate', 'IfcSpace']) {
    operations.push(create(ifcClass, { Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]].map(([x, y]) => [x * factor, y * factor]),
      ...(ifcClass === 'IfcSpace' ? { height: 3 * factor } : { thickness: .2 * factor }) }, `shape-${operations.length}`));
    expected.push(null);
  }
  const proposed = batch(operations, units);
  const sourceCount = view.getNewEntities().length;
  const preview = previewModelAuthoring(useViewerStore.getState(), proposed);
  assert.deepEqual(preview.rows.map((row) => [row.status, row.issue]), operations.map(() => ['ready', undefined]));
  const ghosts = authoringGhosts(useViewerStore.getState(), preview);
  assert.equal(ghosts.length, 31, 'all bounded native shapes have their own section/footprint ghost');
  assert.ok(ghosts.every((mesh) => mesh.indices.length > 0 && [...mesh.positions].every(Number.isFinite)));
  assert.equal(view.getNewEntities().length, sourceCount, 'native dry-run and ghosts publish nothing');
  const committed = commitModelAuthoring(useViewerStore, preview, new Set(preview.rows.map((row) => row.index)), 'native shapes');
  assert.ok(committed.ok, committed.ok ? '' : committed.detail ?? committed.reason);
  const appliedState = useViewerStore.getState();
  assert.equal(changeOperations(appliedState.undoStacks, appliedState.mutationBatchTags, inverseMutationTargets(useViewerStore)).length, 1, 'one native Changes/undo transaction');
  const bytes = editedModelBytes(dataStore, view);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  const reparsed = await parseIfc(bytes);
  const state = useViewerStore.getState();
  const readState = { ...state, models: new Map([[SAMPLE_MODEL, { ...state.models.get(SAMPLE_MODEL)!, ifcDataStore: reparsed }]]), mutationViews: new Map([[SAMPLE_MODEL, new MutablePropertyView(reparsed.properties, SAMPLE_MODEL)]]), storeEditors: new Map() };
  for (const [i, applied] of committed.receipt.applied.entries()) {
    const id = reparsed.entities.getExpressIdByGlobalId(applied.globalId);
    assert.ok(id > 0, `created identity ${i} survives independent export`);
    assert.equal(reparsed.entities.getTypeName(id), applied.field);
    const storey = reparsed.entities.getExpressIdByGlobalId(GROUND_STOREY);
    if (applied.field === 'IfcSpace') assert.ok(reparsed.relationships.getRelated(storey, RelationshipType.Aggregates, 'forward').includes(id), 'native space aggregation belongs to the requested storey');
    else assert.equal(reparsed.spatialHierarchy?.elementToStorey.get(id), storey, 'native created shape is contained in the requested storey');
    if (expected[i]) assert.deepEqual(readElementProfile(readState, SAMPLE_MODEL, id), expected[i], `native exported section ${i} matches dimensions/type`);
  }
  assert.deepEqual(undoModelChanges(useViewerStore, committed.receipt), { ok: true });
  const undone = await parseIfc(editedModelBytes(dataStore, view));
  for (const [i, applied] of committed.receipt.applied.entries()) assert.equal(undone.entities.getExpressIdByGlobalId(applied.globalId), -1, `one native undo removes creation ${i} ${applied.field} ${applied.after}`);
});

test('#7215 excessive/invalid native shape proposals refuse atomically with a reported vertex bound', async () => {
  const { view } = await seedAuthoringSample();
  const polygon = (OuterCurve: unknown) => create('IfcSlab', { Profile: 'polygon', OuterCurve, thickness: .2 });
  assert.throws(() => batch([polygon(Array.from({ length: AUTHORING_VERTEX_LIMIT + 1 }, (_, i) => [i, 0]))]), /3–256 vertices.*no vertices are silently discarded/);
  const large = Array.from({ length: AUTHORING_VERTEX_LIMIT }, (_, i) => [Math.cos(i * 2 * Math.PI / AUTHORING_VERTEX_LIMIT), Math.sin(i * 2 * Math.PI / AUTHORING_VERTEX_LIMIT)]);
  assert.throws(() => batch(Array.from({ length: 5 }, (_, i) => ({ ...polygon(large), ref: `bounded-${i}` }))), /polygon preview work exceeds 262144.*split this proposal/);
  assert.throws(() => batch([create('IfcBeam', { start: [0, 0, 0], end: [4, 0, 0], Profile: { Type: 'Circle', Radius: .2, InventedDimension: .1 } })]), /unsupported native Profile dimension InventedDimension/);
  assert.throws(() => batch([create('IfcBeam', { start: [0, 0, 0], end: [4, 0, 0], Profile: { Type: 'CircleHollow', Radius: .1, WallThickness: .2 } })]), /WallThickness must be less than Radius/);
  assert.throws(() => batch([polygon([[0, 0], [1, Number.POSITIVE_INFINITY], [0, 1]])]), /must be a number/);
  assert.equal(view.getNewEntities().length, 0, 'invalid shape dry-run leaves no published native writes');
});


test('#7215 profiled creation refs and export remain model-local at one and N models', async () => {
  const { dataStore: first, view: firstView } = await seedAuthoringSample();
  assert.equal(useViewerStore.getState().models.size, 1);
  const second = await parseIfc(first.source.materialize());
  const firstModel = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  const secondView = new MutablePropertyView(second.properties, 'second');
  useViewerStore.setState({ ...fixtureModels(firstModel, { ...firstModel, id: 'second', idOffset: 1_000_000, ifcDataStore: second }),
    mutationViews: new Map([[SAMPLE_MODEL, firstView], ['second', secondView]]) });
  const shape = { ...create('IfcBeam', { start: [0, 0, 3], end: [4, 0, 3], Profile: { Type: 'Circle', Radius: .2 } }, 'second-shape'), storey: { globalId: GROUND_STOREY, modelId: 'second' } };
  const proposed = batch([shape, { op: 'material.assign', target: { ref: 'second-shape' }, material: { name: 'stone_sand-lime' } }]);
  const preview = previewModelAuthoring(useViewerStore.getState(), proposed);
  assert.deepEqual(preview.rows.map((row) => [row.status, row.modelId]), [['ready', 'second'], ['ready', 'second']]);
  assert.deepEqual(preview.rows[1].dependsOn, [0]);
  assert.equal(firstView.getNewEntities().length + secondView.getNewEntities().length, 0, 'federated draft does not publish edits');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0, 1]), 'federated native shape');
  assert.ok(outcome.ok);
  const globalId = outcome.receipt.applied[0].globalId;
  const a = await parseIfc(editedModelBytes(first, firstView)), b = await parseIfc(editedModelBytes(second, secondView));
  assert.equal(a.entities.getExpressIdByGlobalId(globalId), -1, 'same source identities in model A receive no authored shape');
  const id = b.entities.getExpressIdByGlobalId(globalId);
  assert.ok(id > 0);
  assert.ok(b.relationships.getRelated(id, RelationshipType.AssociatesMaterial, 'inverse').length > 0, 'actual in-batch reference assignment survives native export in model B');
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  assert.equal((await parseIfc(editedModelBytes(second, secondView))).entities.getExpressIdByGlobalId(globalId), -1);
});
