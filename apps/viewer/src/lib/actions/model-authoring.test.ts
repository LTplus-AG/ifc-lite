/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { changeOperations } from '@/lib/changes/change-operations';
import { inverseMutationTargets } from '@/store/slices/mutation-inverse-registry';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { BACK_WALL, BACK_WALL_NAME, FRONT_WALL_TYPE, FRONT_WALL_TYPE_NAME, GROUND_STOREY, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample }
  from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch, type ModelAuthoringBatch } from './model-authoring';
import { authoredElementOf } from './model-authoring-native';
import { authoringCounts, previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { setRequestRemesh, type RemeshRequest } from '@/lib/commands/modeling/transaction';
import { authoringReader, materialNameOf, nameOf, typeNameOf } from './model-authoring-read';
import { undoModelChanges } from './model-change-commit';
import { decodeModelChangeReceipt } from './receipts';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));

const batch = (operations: unknown[], extra: Record<string, unknown> = {}): ModelAuthoringBatch =>
  parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Annex', units: 'mm', frame: 'storey-local', operations, ...extra }));

const storey = { globalId: GROUND_STOREY };
const wallA = { op: 'element.create', ref: 'wall-a', ifcClass: 'IfcWall', storey, name: 'Annex south',
  params: { start: [10000, 10000, 0], end: [14000, 10000, 0], thickness: 200, height: 3000 } };
const wallB = { op: 'element.create', ref: 'wall-b', ifcClass: 'IfcWall', storey, name: 'Annex east',
  params: { start: [14000, 10000, 0], end: [14000, 13000, 0], thickness: 200, height: 3000 } };
const door = { op: 'hosted.create', ref: 'door-1', kind: 'door', host: { ref: 'wall-a' }, name: 'Annex door', offset: 2000, sill: 0, width: 900, height: 2100 };
const backWall = { globalId: BACK_WALL, ifcClass: 'IfcWall', name: BACK_WALL_NAME };

test('the contract refuses undeclared units or frames, unit mistakes, unsupported classes and dangling refs', () => {
  const refuse = (pattern: RegExp, operations: unknown[], extra: Record<string, unknown> = {}) =>
    assert.throws(() => batch(operations, extra), pattern);
  refuse(/declare "units"/, [wallA], { units: undefined });
  refuse(/"frame": "storey-local"/, [wallA], { frame: 'world' });
  refuse(/thickness is 200 m, outside 0.01–5 m; check the declared "units"/,
    [{ ...wallA, params: { start: [10, 10, 0], end: [14, 10, 0], thickness: 200, height: 3 } }], { units: 'm' });
  refuse(/ifcClass must be one of .*not authored/, [{ ...wallA, ifcClass: 'IfcCurtainWall' }]);
  refuse(/refers to "nowhere"/, [{ ...door, host: { ref: 'nowhere' } }]);
  refuse(/vertical moves are not supported/, [{ op: 'element.move', target: backWall, delta: [0, 0, 100] }]);
  refuse(/must state the element's expected ifcClass/, [{ op: 'element.delete', target: { globalId: BACK_WALL, name: '' } }]);
  refuse(/hosted in walls only/, [{ ...door, host: { globalId: BACK_WALL, ifcClass: 'IfcSlab', name: 'x' } }]);
  refuse(/reuses ref/, [wallA, { ...wallB, ref: 'wall-a' }]);
  const metres = authoredElementOf(batch([wallA]), batch([wallA]).operations[0] as never);
  const sameInMetres = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'm', units: 'm', frame: 'storey-local',
    operations: [{ ...wallA, params: { start: [10, 10, 0], end: [14, 10, 0], thickness: 0.2, height: 3 } }] }));
  assert.deepEqual(authoredElementOf(sameInMetres, sameInMetres.operations[0] as never), metres, 'mm and m batches reach the builder as the same metres');
});

test('preview resolves storeys, refs, types and materials, runs the builders on a draft and writes nothing', async () => {
  const { view } = await seedAuthoringSample();
  const before = view.getNewEntities().length;
  const preview = previewModelAuthoring(useViewerStore.getState(), batch([
    wallA, wallB, door,
    { op: 'walls.join', walls: [{ ref: 'wall-a' }, { ref: 'wall-b' }] },
    { op: 'type.assign', target: { ref: 'wall-a' }, type: { globalId: FRONT_WALL_TYPE, name: FRONT_WALL_TYPE_NAME } },
    { op: 'material.assign', target: { ref: 'wall-b' }, material: { name: 'stone_sand-lime' } },
    { op: 'type.assign', target: backWall, expected: 'house - outer wall - house right back', type: { globalId: FRONT_WALL_TYPE, name: FRONT_WALL_TYPE_NAME } },
    { op: 'element.move', target: { ...backWall, name: 'renamed meanwhile' }, delta: [500, 0] },
    { op: 'element.create', ref: 'x', ifcClass: 'IfcSlab', storey: { globalId: '0000000000000000000000' }, name: 'Lost', params: { position: [0, 0, 0], width: 1000, depth: 1000, thickness: 200 } },
  ]));
  assert.deepEqual(preview.rows.map((row) => row.status),
    ['ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'conflict', 'missing-target']);
  assert.match(preview.rows[7].issue ?? '', /Expected IfcWall "renamed meanwhile"; the model has IfcWall "house - outer wall - house right back"/);
  assert.equal(preview.rows[0].before.storeyName, '00 groundfloor');
  assert.equal(preview.rows[6].before.type, 'house - outer wall - house right back');
  assert.deepEqual(preview.rows[2].dependsOn, [0]);
  assert.equal(view.getNewEntities().length, before, 'the dry run never publishes its draft');
  assert.equal(useViewerStore.getState().undoStacks.size, 0);
});

test('the native builders refuse what the contract cannot see, and rows using a refused creation are blocked', async () => {
  await seedAuthoringSample();
  const preview = previewModelAuthoring(useViewerStore.getState(), batch([
    wallA, { ...door, width: 5000 }, { ...door, ref: 'door-2', offset: 500, width: 900 },
    { op: 'type.assign', target: { ref: 'wall-a' }, type: { create: { ifcClass: 'IfcWallType', name: 'Annex 200' } } },
    { op: 'material.assign', target: { ref: 'wall-a' }, material: { name: 'no such material' } },
  ]));
  assert.deepEqual(preview.rows.map((row) => row.status), ['ready', 'invalid', 'ready', 'ready', 'missing-target']);
  assert.match(preview.rows[1].issue ?? '', /\S/, 'the builder says why');
  assert.match(preview.rows[4].issue ?? '', /set "create": true/);
  const blocked = previewModelAuthoring(useViewerStore.getState(), batch([{ ...wallA, storey: { globalId: '0000000000000000000000' } }, door]));
  assert.deepEqual(blocked.rows.map((row) => row.status), ['missing-target', 'blocked']);
});

test('without Edit mode every row is refused by the native edit gate', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const preview = previewModelAuthoring(useViewerStore.getState(), batch([wallA, { op: 'element.delete', target: backWall }]));
  assert.deepEqual(preview.rows.map((row) => row.status), ['denied', 'denied']);
  assert.match(preview.rows[0].issue ?? '', /Edit mode/);
  assert.equal(authoringCounts(preview.rows).denied, 2);
});

test('approved rows commit as one native undo step, export with referential integrity, and undo restores the model', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const preview = previewModelAuthoring(useViewerStore.getState(), batch([
    wallA, wallB, door,
    { op: 'walls.join', walls: [{ ref: 'wall-a' }, { ref: 'wall-b' }] },
    { op: 'type.assign', target: { ref: 'wall-a' }, type: { globalId: FRONT_WALL_TYPE, name: FRONT_WALL_TYPE_NAME } },
    { op: 'material.assign', target: { ref: 'wall-b' }, material: { name: 'stone_sand-lime' } },
    { op: 'material.assign', target: { ref: 'wall-a' }, material: { name: 'Annex render', create: true } },
  ]));
  assert.equal(authoringCounts(preview.rows).ready, 7);
  const remesh: RemeshRequest[] = [];
  const restore = setRequestRemesh((_get, request) => { remesh.push(request); });
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set(preview.rows.map((row) => row.index)), 'test');
  restore();
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const { receipt } = outcome;
  assert.equal(receipt.kind, 'model.authoring');
  assert.equal(receipt.batches.length, 1);
  const state = useViewerStore.getState();
  const operations = changeOperations(state.undoStacks, state.mutationBatchTags, inverseMutationTargets(useViewerStore));
  assert.equal(operations.length, 1, 'the whole batch is one row in Changes and one Ctrl+Z');
  assert.equal(remesh.length, 1, 'one re-mesh request for the commit');
  assert.equal(remesh[0].batchId, receipt.batches[0].batchId);
  assert.equal(remesh[0].cause, 'created');
  assert.equal(remesh[0].expressIds.length >= 3, true, 'the created walls and door (and the host) are re-meshed');

  const [wallAGid, wallBGid, doorGid] = receipt.applied.slice(0, 3).map((change) => change.globalId);
  const exported = new TextDecoder().decode(editedModelBytes(dataStore, view));
  assert.deepEqual(danglingReferences(exported), [], 'every #reference of the export names an entity');
  const reparsed = await parseIfc(new TextEncoder().encode(exported));
  const wall = reparsed.entities.getExpressIdByGlobalId(wallAGid)!;
  const doorId = reparsed.entities.getExpressIdByGlobalId(doorGid)!;
  assert.ok(wall > 0 && doorId > 0 && reparsed.entities.getExpressIdByGlobalId(wallBGid)! > 0, 'created elements survive export/reparse by GlobalId');
  assert.equal(reparsed.entities.getName(wall), 'Annex south');
  const storeyId = reparsed.entities.getExpressIdByGlobalId(GROUND_STOREY)!;
  assert.equal(reparsed.spatialHierarchy?.elementToStorey.get(wall), storeyId, 'the created wall is contained in the storey');
  const reader = { ...authoringReader({ ...useViewerStore.getState(), models: new Map([['r', { ...state.models.get(SAMPLE_MODEL)!, ifcDataStore: reparsed }]]),
    mutationViews: new Map() }, 'r')! };
  assert.equal(typeNameOf(reader, wall), FRONT_WALL_TYPE_NAME, 'the type relationship is exported');
  assert.equal(materialNameOf(reader, wall), 'Annex render');
  assert.equal(materialNameOf(reader, reparsed.entities.getExpressIdByGlobalId(wallBGid)!), 'stone_sand-lime');
  assert.match(exported, new RegExp(`IFCRELVOIDSELEMENT\\([^;]*#${wallStepId(exported, wallAGid)},#\\d+\\)`), 'the opening voids the created wall');
  assert.match(exported, /IFCRELFILLSELEMENT\(/, 'the door fills the opening');
  assert.match(exported, /IFCRELCONNECTSPATHELEMENTS\(/, 'the walls are joined');
  assert.ok(decodeModelChangeReceipt(JSON.parse(JSON.stringify(receipt))), 'the receipt survives serialization');

  const undone = undoModelChanges(useViewerStore, receipt);
  assert.deepEqual(undone, { ok: true });
  const after = new TextDecoder().decode(editedModelBytes(dataStore, view));
  assert.doesNotMatch(after, new RegExp(wallAGid.replace(/\$/g, '\\$')), 'undo removes the created wall from the export');
  assert.doesNotMatch(after, /IFCRELFILLSELEMENT\(/);
});

function wallStepId(step: string, globalId: string): number {
  const line = step.split('\n').find((candidate) => candidate.includes(`IFCWALL('${globalId}'`));
  return Number(/^#(\d+)/.exec(line ?? '')?.[1]);
}

test('moves, turns and deletes existing elements with export/reparse proof; expected positions and stale previews are refused', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const wrongFrom = previewModelAuthoring(useViewerStore.getState(), batch([{ op: 'element.move', target: backWall, delta: [500, 0], from: [0, 0] }]));
  assert.equal(wrongFrom.rows[0].status, 'conflict');
  const preview = previewModelAuthoring(useViewerStore.getState(), batch([
    { op: 'element.move', target: backWall, delta: [500, -250] },
    { op: 'element.rotate', target: backWall, angleDeg: 90 },
    { op: 'element.delete', target: { globalId: '1uS5vfZPn9R8PlAaVd73on', ifcClass: 'IfcWall', name: 'plumbing wall' } },
  ]));
  assert.deepEqual(preview.rows.map((row) => [row.status, row.issue]), [['ready', undefined], ['ready', undefined], ['ready', undefined]]);
  const origin = preview.rows[0].before.origin!;
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0, 1, 2]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  assert.deepEqual(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test'), { ok: false, reason: 'stale' }, 'a preview is single-use');

  const reparsed = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(reparsed.entities.getExpressIdByGlobalId('1uS5vfZPn9R8PlAaVd73on'), -1, 'the deleted wall is not exported');
  const exported = new TextDecoder().decode(editedModelBytes(dataStore, view));
  assert.deepEqual(danglingReferences(exported), []);
  const [moved, turned] = previewModelAuthoring({ ...useViewerStore.getState(), models: new Map([[SAMPLE_MODEL, { ...useViewerStore.getState().models.get(SAMPLE_MODEL)!, ifcDataStore: reparsed }]]),
    mutationViews: new Map() }, batch([{ op: 'element.move', target: backWall, delta: [1, 0] }, { op: 'element.rotate', target: backWall, angleDeg: 10 }])).rows;
  assert.ok(Math.abs(moved.before.origin![0] - (origin[0] + 0.5)) < 1e-6 && Math.abs(moved.before.origin![1] - (origin[1] - 0.25)) < 1e-6,
    'the exported placement moved by (500, -250) mm');
  assert.ok(Math.abs(turned.before.angleDeg! - (preview.rows[1].before.angleDeg! + 90)) < 0.01, 'the exported placement is turned by 90°');
  const reader = authoringReader({ ...useViewerStore.getState(), models: new Map([['r', { ...useViewerStore.getState().models.get(SAMPLE_MODEL)!, ifcDataStore: reparsed }]]), mutationViews: new Map() }, 'r')!;
  assert.equal(nameOf(reader, reparsed.entities.getExpressIdByGlobalId(BACK_WALL)!), BACK_WALL_NAME);
});

test('a later batch finds elements created this session by GlobalId, and refuses deleting a wall that hosts a door', async () => {
  await seedAuthoringSample();
  const first = previewModelAuthoring(useViewerStore.getState(), batch([wallA, door]));
  const committed = commitModelAuthoring(useViewerStore, first, new Set([0, 1]), 'test');
  assert.ok(committed.ok);
  const created = { globalId: committed.receipt.applied[0].globalId, ifcClass: 'IfcWall', name: 'Annex south' };
  const second = previewModelAuthoring(useViewerStore.getState(), batch([
    { op: 'element.delete', target: created },
    { op: 'material.assign', target: created, expected: null, material: { name: 'stone_sand-lime' } },
  ]));
  assert.deepEqual(second.rows.map((row) => row.status), ['unsupported', 'ready']);
  assert.match(second.rows[0].issue ?? '', /hosts 1 opening/);
});

test('receipts of both producers decode, and an unknown receipt kind is refused', () => {
  const p04 = { version: 1, id: 'r1', title: 'Names', digest: 'mc1-0', createdAt: '2026-01-01T00:00:00.000Z', origin: 'test',
    batches: [{ modelId: 'A', batchId: 'b' }], applied: [{ index: 0, op: 'attribute.set', globalId: BACK_WALL, modelId: 'A', field: 'Name', before: 'a', after: 'b' }],
    skipped: [], status: 'applied' };
  assert.equal(decodeModelChangeReceipt(p04)?.kind, undefined, 'a P04 receipt still decodes unchanged');
  const authoring = { ...p04, kind: 'model.authoring', applied: [{ ...p04.applied[0], op: 'element.create', field: 'IfcWall', before: null, after: 'Annex' }] };
  assert.equal(decodeModelChangeReceipt(authoring)?.applied[0].op, 'element.create');
  assert.equal(decodeModelChangeReceipt({ ...authoring, kind: 'model.other' }), null);
});
