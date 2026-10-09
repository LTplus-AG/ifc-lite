/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { MODEL, seedNativeSdkModel, settle } from '@/test/native-sdk-model';
import { useViewerStore } from '@/store';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { toGlobalIdFromModels } from '@/store/globalId';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseIfc } from '@/test/authoring-sample-fixture';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';

const original = useViewerStore.getState();
afterEach(() => { setRemeshClientFactory(null); useViewerStore.setState(original, true); });
const artifact = process.env.CAMPAIGN_STOREY_PUBLIC_ARTIFACT;
const fixtureOptions = { skip: artifact ? false : 'Native inverse fixture absent: capture it with CAMPAIGN_STOREY_PUBLIC_ARTIFACT through the root reviewed reassignment test' };
async function load() {
  assert.ok(artifact);
  const captured = JSON.parse(await readFile(artifact, 'utf8')) as { step: string; envelope: string; expressId: number; destinationId: number };
  const { store, adapter, view } = await seedNativeSdkModel(new TextEncoder().encode(captured.step));
  const models = new Map(useViewerStore.getState().models);
  models.set(MODEL, { ...models.get(MODEL)!, maxExpressId: getMaxExpressId(store, []) });
  useViewerStore.setState({ models });
  return { ...captured, store, adapter, view };
}
const graph = async (bytes: Uint8Array) => {
  const store = await parseIfc(bytes);
  return [...store.entityIndex.byId.keys()].sort((a,b)=>a-b).map(id=>({id,...store.getEntity(id)}));
};

test('#7328 public admission native control: existing copy is available and creates a distinct identity', fixtureOptions, async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await load(), sourceGuid = s.store.entities.getGlobalId(s.expressId);
  assert.ok(s.adapter.copyElements);
  const copies = s.adapter.copyElements(MODEL, [s.expressId], [{ offset: [0, 2, 0] }]);
  assert.equal(copies.length,1); await settle();
  const rendererId = toGlobalIdFromModels(useViewerStore.getState().models, MODEL, copies[0].expressId);
  assert.ok(useViewerStore.getState().models.get(MODEL)?.geometryResult?.meshes.some(mesh => mesh.expressId === rendererId && mesh.indices.length > 0), 'existing native Copy produces an actual remeshed body');
  const copied = await parseIfc(editedModelBytes(s.store,s.view));
  assert.notEqual(copies[0].expressId,s.expressId);
  assert.notEqual(copied.entities.getGlobalId(copies[0].expressId),sourceGuid);
  assert.equal(copied.entities.getGlobalId(s.expressId),sourceGuid);
});

test('#7328 unchanged public authoring endpoints admit a complete independently saved native same-identity envelope', fixtureOptions, async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await load(), bytes = () => editedModelBytes(s.store,s.view), before = await graph(bytes());
  // Before the feature this is the canonical unsupported-envelope refusal,
  // not a loader/missing-export error: this probe imports only existing APIs.
  const batch = parseModelAuthoringBatch(s.envelope);
  const preview = previewModelAuthoring(useViewerStore.getState(),batch);
  assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
  const result = commitModelAuthoring(useViewerStore,preview,new Set([0]),'#7328 public endpoint admission');
  assert.ok(result.ok,result.ok?'':result.detail??result.reason); await settle();
  const saved = await parseIfc(bytes());
  assert.equal(saved.entities.getExpressIdByGlobalId(s.store.entities.getGlobalId(s.expressId)),s.expressId);
  assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true}); await settle();
  assert.deepEqual(await graph(bytes()),before);
});
