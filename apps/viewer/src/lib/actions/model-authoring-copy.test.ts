/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { createCopyContext, productStoreyOrigin } from '@ifc-lite/create';
import { seedModelingSession, MODEL_ID, MESH_WALL, UPPER_STOREY } from '@/test/modeling-session-fixture';
import { IfcQuery } from '@ifc-lite/query';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { BACK_WALL, BACK_WALL_NAME, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const target = { globalId: BACK_WALL, ifcClass: 'IfcWall', name: BACK_WALL_NAME };
const batch = (operations: unknown[]) => parseModelAuthoringBatch(JSON.stringify({
  version: 1, kind: 'model.authoring', title: 'Reviewed copies', units: 'mm', frame: 'storey-local', operations,
}));
const copy = { op: 'element.copy', target, ref: 'copy', offset: [1000, 0, 0] };

// #7202: real committed SketchUp source; the remesh client only records requests.
// This proves the native mutation/export/undo contract, not rendered geometry.
test('#7202 reviewed copy dry-runs without publication and exports a fresh native identity with one undo batch', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  assert.ok(dataStore.entities.getExpressIdByGlobalId(BACK_WALL) > 0);
  const preview = previewModelAuthoring(useViewerStore.getState(), batch([copy]));
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), [['ready', undefined]]);
  assert.equal(view.getNewEntities().length, 0, 'draft copy is never published');
  const requests: number[][] = [];
  const restore = setRequestRemesh((_get, request) => { requests.push([...request.expressIds]); });
  let outcome;
  try { outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test'); } finally { restore(); }
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  assert.equal(outcome.receipt.batches.length, 1);
  const gid = outcome.receipt.applied[0].globalId;
  assert.notEqual(gid, BACK_WALL);
  const bytes = editedModelBytes(dataStore, view);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  const parsed = await parseIfc(bytes);
  const id = parsed.entities.getExpressIdByGlobalId(gid);
  assert.ok(id > 0);
  assert.equal(parsed.entities.getName(id), BACK_WALL_NAME);
  const source = productStoreyOrigin(createCopyContext(dataStore, new StoreEditor(dataStore, view)), dataStore.entities.getExpressIdByGlobalId(BACK_WALL))!;
  const placed = productStoreyOrigin(createCopyContext(parsed, new StoreEditor(parsed, new MutablePropertyView(parsed.properties || null, 'parsed'))), id)!;
  assert.ok(Math.abs(placed.origin[0] - source.origin[0] - 1) < 0.001);
  assert.ok(Math.abs(placed.origin[1] - source.origin[1]) < 0.001);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].length > 0);
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  const undone = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(undone.entities.getExpressIdByGlobalId(gid), -1);
  assert.ok(undone.entities.getExpressIdByGlobalId(BACK_WALL) > 0);
});

test('#7202 linear array writes each fresh identity and a dependent material assignment uses the approved copy ref', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const preview = previewModelAuthoring(useViewerStore.getState(), batch([
    { op: 'element.array', target, refs: ['first', 'second'], mode: 'linear', count: 3, anchor: [0, 0], cursor: [1000, 0], distance: 1000 },
    { op: 'material.assign', target: { ref: 'second' }, material: { name: 'Reviewed copy finish', create: true } },
  ]));
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), [['ready', undefined], ['ready', undefined]]);
  assert.equal(view.getNewEntities().length, 0);
  const refusedDependency = commitModelAuthoring(useViewerStore, preview, new Set([1]), 'test');
  assert.deepEqual(refusedDependency, { ok: false, reason: 'nothing-approved' });
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0, 1]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const fresh = outcome.receipt.applied.filter(change => change.op === 'element.array');
  assert.equal(fresh.length, 2, 'each copy has its own receipt identity');
  assert.equal(new Set(fresh.map(change => change.globalId)).size, 2);
  for (const change of fresh) assert.ok(parsed.entities.getExpressIdByGlobalId(change.globalId) > 0);
  assert.equal(outcome.receipt.applied[2].globalId, fresh[1].globalId);
  assert.equal(outcome.receipt.batches.length, 1);
});

test('#7202 a preview cannot copy from a reloaded source with the same model name and mutation version', async () => {
  await seedAuthoringSample();
  const preview = previewModelAuthoring(useViewerStore.getState(), batch([copy]));
  assert.equal(preview.rows[0].status, 'ready');
  await seedAuthoringSample();
  assert.equal(useViewerStore.getState().mutationVersion, preview.mutationVersion);
  assert.deepEqual(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test'), { ok: false, reason: 'stale' });
  assert.equal(useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)!.getNewEntities().length, 0);
});

test('#7202 bounds array population, finite transforms, unique refs, and native permission/name/placement refusals', async () => {
  await seedAuthoringSample();
  const linear = { op: 'element.array', target, refs: ['a', 'b'], mode: 'linear', count: 3, anchor: [0, 0], cursor: [1000, 0] };
  assert.throws(() => batch([{ ...linear, count: 10001 }]), /count/);
  assert.throws(() => batch([{ ...linear, refs: ['a', 'a'] }]), /reuses ref/);
  assert.throws(() => batch([{ ...copy, angleDeg: 90 }]), /pivot/);
  assert.throws(() => batch([{ ...copy, offset: [Infinity, 0, 0] }]), /number/);
  assert.throws(() => batch([{ ...linear, count: 201, refs: Array.from({ length: 200 }, (_, i) => `a${i}`) }, copy]), /at most 200 copy roots/);
  const wrong = previewModelAuthoring(useViewerStore.getState(), batch([{ ...copy, target: { ...target, name: 'wrong' } }]));
  assert.equal(wrong.rows[0].status, 'conflict');
  const placement = previewModelAuthoring(useViewerStore.getState(), batch([{ ...copy, from: [0, 0] }]));
  assert.equal(placement.rows[0].status, 'conflict');
  const noDirection = previewModelAuthoring(useViewerStore.getState(), batch([{ ...linear, cursor: [0, 0] }]));
  assert.equal(noDirection.rows[0].status, 'invalid');
  const ordered = previewModelAuthoring(useViewerStore.getState(), batch([{ op: 'element.move', target, delta: [1000, 0] }, copy]));
  assert.equal(ordered.rows[1].status, 'unsupported', 'never show an unchanged source ghost for a copy of an earlier moved source');
  useViewerStore.setState({ editEnabled: false });
  const denied = previewModelAuthoring(useViewerStore.getState(), batch([copy]));
  assert.equal(denied.rows[0].status, 'denied');
});

test('#7202 copied draft host retains its authored filling through native export and selective approval', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const preview = previewModelAuthoring(useViewerStore.getState(), batch([
    { op: 'element.create', ref: 'source', ifcClass: 'IfcWall', storey: { globalId: '1Ano2ZUxnEIvVQ_beukl8b' }, name: 'Explicit copy host',
      params: { start: [10000, 10000, 0], end: [14000, 10000, 0], thickness: 200, height: 3000 } },
    { op: 'hosted.create', ref: 'door', kind: 'door', host: { ref: 'source' }, name: 'Explicit filling', offset: 2000, sill: 0, width: 900, height: 2100 },
    { ...copy, target: { ref: 'source' }, ref: 'cloned' },
    { op: 'material.assign', target: { ref: 'cloned' }, material: { name: 'Copied finish', create: true } },
  ]));
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), Array.from({ length: 4 }, () => ['ready', undefined]));
  assert.equal(view.getNewEntities().length, 0);
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0, 1, 2, 3]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const query = new IfcQuery(parsed);
  const gid = outcome.receipt.applied[2].globalId;
  const copiedWall = query.entity(parsed.entities.getExpressIdByGlobalId(gid));
  const openings = copiedWall.voids();
  assert.equal(openings.length, 1);
  const fillers = openings[0].filledBy();
  assert.equal(fillers.length, 1);
  assert.equal(fillers[0].name, 'Explicit filling');
  assert.notEqual(fillers[0].globalId, outcome.receipt.applied[1].globalId);
  assert.equal(outcome.receipt.applied[2].after, 'Explicit copy host', 'receipt records the actual copied name');
  assert.equal(outcome.receipt.batches.length, 1);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(editedModelBytes(dataStore, view))), []);
});

test('#7202 federated copy refuses ambiguous GlobalIds and confines a pinned copy to its owning model', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const current = useViewerStore.getState();
  const other = { ...current.models.get(SAMPLE_MODEL)!, id: 'other', name: 'other.ifc', idOffset: 1_000_000 };
  useViewerStore.setState({ models: new Map([...current.models, ['other', other]]) });
  const ambiguous = previewModelAuthoring(useViewerStore.getState(), batch([copy]));
  assert.equal(ambiguous.rows[0].status, 'ambiguous-target');
  const pinned = previewModelAuthoring(useViewerStore.getState(), batch([{ ...copy, target: { ...target, modelId: SAMPLE_MODEL } }]));
  assert.equal(pinned.rows[0].status, 'ready');
  const outcome = commitModelAuthoring(useViewerStore, pinned, new Set([0]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  assert.equal(outcome.receipt.batches[0].modelId, SAMPLE_MODEL);
  assert.equal(useViewerStore.getState().mutationViews.has('other'), false);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  assert.ok(parsed.entities.getExpressIdByGlobalId(outcome.receipt.applied[0].globalId) > 0);
  assert.equal(dataStore.entities.getExpressIdByGlobalId(outcome.receipt.applied[0].globalId), -1);
});


// Stated invariant fixture: two native IFC4 storeys, model-unit variants and a displaced storey.
test('#7202 target storey and polar placements export in native file units for metre and millimetre models', async () => {
  for (const unit of ['metre', 'millimetre'] as const) {
    const view = await seedModelingSession({ unit, storeyOffset: [3, 7] });
    const dataStore = useViewerStore.getState().models.get(MODEL_ID)!.ifcDataStore!;
    const source = productStoreyOrigin(createCopyContext(dataStore, new StoreEditor(dataStore, view)), MESH_WALL)!;
    assert.deepEqual(source.origin, [0, 5, 0]);
    const target = { globalId: dataStore.entities.getGlobalId(MESH_WALL), ifcClass: 'IfcWall', name: 'mesh wall' };
    const preview = previewModelAuthoring(useViewerStore.getState(), batch([
      { op: 'element.array', target, refs: ['half', 'quarter'], mode: 'polar', count: 3, anchor: [0, 0], angleDeg: 90,
        from: [0, 5000], storey: { globalId: dataStore.entities.getGlobalId(UPPER_STOREY) } },
    ]));
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native array preview must be ready');
    const restore = setRequestRemesh(() => {});
    let outcome;
    try { outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test'); } finally { restore(); }
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
    const parsed = await parseIfc(editedModelBytes(dataStore, view));
    const ids = outcome.receipt.applied.map(change => parsed.entities.getExpressIdByGlobalId(change.globalId));
    const upper = parsed.entities.getExpressIdByGlobalId(dataStore.entities.getGlobalId(UPPER_STOREY));
    const ctx = createCopyContext(parsed, new StoreEditor(parsed, new MutablePropertyView(parsed.properties || null, MODEL_ID)));
    for (const [index, id] of ids.entries()) {
      const placed = productStoreyOrigin(ctx, id)!;
      const angle = (index + 1) * Math.PI / 4;
      assert.equal(placed.storeyId, upper);
      assert.ok(Math.abs(placed.origin[0] + 5 * Math.sin(angle)) < 0.001);
      assert.ok(Math.abs(placed.origin[1] - 5 * Math.cos(angle)) < 0.001);
    }
    assert.deepEqual(danglingReferences(new TextDecoder().decode(editedModelBytes(dataStore, view))), []);
  }
});

test('#7202 wall provenance follows copied/array refs for native hosted writes and refuses copied non-wall hosts', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const wall = { op: 'element.create', ref: 'wall', ifcClass: 'IfcWall', storey: { globalId: '1Ano2ZUxnEIvVQ_beukl8b' }, name: 'Copy-ref host',
    params: { start: [10000, 10000, 0], end: [14000, 10000, 0], thickness: 200, height: 3000 } };
  const host = { op: 'hosted.create', ref: 'door', kind: 'door', host: { ref: 'cloned' }, name: 'Copy-ref door', offset: 2000, sill: 0, width: 900, height: 2100 };
  const proposal = batch([wall, { ...copy, target: { ref: 'wall' }, ref: 'first' },
    { op: 'element.array', target: { ref: 'first' }, refs: ['cloned'], mode: 'linear', count: 2, anchor: [0, 0], cursor: [0, 1000] }, host]);
  const preview = previewModelAuthoring(useViewerStore.getState(), proposal);
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), Array.from({ length: 4 }, () => ['ready', undefined]));
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0, 1, 2, 3]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const copied = new IfcQuery(parsed).entity(parsed.entities.getExpressIdByGlobalId(outcome.receipt.applied[2].globalId));
  assert.equal(copied.voids().length, 1);
  assert.equal(copied.voids()[0].filledBy()[0].globalId, outcome.receipt.applied[3].globalId);
  assert.throws(() => batch([{ ...copy, target: { ...target, ifcClass: 'IfcSlab' }, ref: 'cloned' }, host]), /slab hosts support bare openings only/);
});

test('#7202 native skip-history overlay edits invalidate a copy even without a viewer mutation notification', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const preview = previewModelAuthoring(useViewerStore.getState(), batch([copy]));
  const id = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
  const revision = view.getMutationRevision();
  view.setAttribute(id, 'Description', 'Native replay after approval', undefined, true);
  assert.ok(view.getMutationRevision() > revision);
  const exported = new TextDecoder().decode(editedModelBytes(dataStore, view));
  assert.match(exported, /Native replay after approval/, 'the native effective edit survives IFC export');
  assert.equal(useViewerStore.getState().mutationVersion, preview.mutationVersion);
  assert.deepEqual(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test'), { ok: false, reason: 'stale' });
  assert.equal(view.getNewEntities().length, 0);
});
