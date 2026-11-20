/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { createStore } from 'zustand/vanilla';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import { createBcfSlice } from './bcfSlice.js';
import { requestValue, transactionDone } from '../../lib/storage/content-database.js';

function makeStore() {
  const { getState } = createStore(createBcfSlice);
  assert.equal(typeof getState().initializeBcfAutosave, 'function', 'the BCF slice can start recovery');
  assert.equal(typeof getState().flushBcfAutosave, 'function', 'the BCF slice can flush a pending edit');
  return getState;
}
const project = (name: string) => createBCFProject({ name });

async function database(): Promise<IDBDatabase> {
  const open = indexedDB.open('ifc-lite-bcf-project', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('project');
  const db = await requestValue(open);
  return db;
}

async function slot(write?: { value: unknown }): Promise<unknown> {
  const db = await database();
  try {
    const tx = db.transaction('project', write ? 'readwrite' : 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore('project');
    const request = write ? store.put(write.value, 'open') : store.get('open');
    const [result] = await Promise.all([requestValue(request), done]);
    return result;
  } finally { db.close(); }
}

beforeEach(async () => {
  const db = await database();
  const tx = db.transaction('project', 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('project').clear();
  await done;
  db.close();
});

test('#10975 BCF edits survive reload and explicit close clears the working copy', async () => {
  const live = makeStore();
  await live().initializeBcfAutosave();
  live().setBcfProject(project('Coordination'));
  const topic = createBCFTopic({ title: 'Clash at grid A', author: 'reviewer@example.com' });
  live().addTopic(topic);
  live().addComment(topic.guid, { guid: 'comment', comment: 'Please check the sleeve', viewpointGuid: 'view' });
  live().addViewpoint(topic.guid, { guid: 'view', snapshot: 'data:image/png;base64,AAEC', snapshotData: new Uint8Array([0, 1, 2]),
    clippingPlanes: [{ location: { x: 1, y: 2, z: 3 }, direction: { x: 0, y: 1, z: 0 } }],
    components: { selection: [{ ifcGuid: 'element' }], visibility: { defaultVisibility: false } },
  });
  assert.equal(await live().flushBcfAutosave(), true);
  const reloaded = makeStore();
  await reloaded().initializeBcfAutosave();
  const restored = reloaded().bcfProject;
  assert.equal(restored?.name, 'Coordination');
  assert.deepEqual(restored?.topics.get(topic.guid)?.viewpoints, live().bcfProject?.topics.get(topic.guid)?.viewpoints);
  assert.deepEqual(restored?.topics.get(topic.guid)?.comments, live().bcfProject?.topics.get(topic.guid)?.comments);
  assert.equal(reloaded().activeTopicId, null);

  reloaded().updateTopic(topic.guid, { title: 'Pending before close' });
  assert.equal(await reloaded().clearBcfProject(), true);
  const closed = makeStore();
  await closed().initializeBcfAutosave();
  assert.equal(closed().bcfProject, null);
  live().updateTopic(topic.guid, { title: 'Stale tab cannot recreate closed project' });
  assert.equal(await live().flushBcfAutosave(), false);
  assert.equal(live().bcfAutosaveStatus, 'conflict');
  closed().setBcfProject(project('Next project'));
  assert.equal(await closed().flushBcfAutosave(), true);
  const next = makeStore();
  await next().initializeBcfAutosave();
  assert.equal(next().bcfProject?.name, 'Next project');
});

test('#10975 replaces the recovery copy when a project opens during startup', async () => {
  const first = makeStore();
  await first().initializeBcfAutosave();
  first().setBcfProject(project('Old'));
  await first().flushBcfAutosave();

  const next = makeStore();
  const restoring = next().initializeBcfAutosave();
  next().setBcfProject(project('Imported'));
  await restoring;
  assert.equal(next().bcfProject?.name, 'Imported');
  assert.equal(await next().flushBcfAutosave(), true);

  const last = makeStore();
  await last().initializeBcfAutosave();
  assert.equal(last().bcfProject?.name, 'Imported');
});

test('#10975 an explicit close during startup also wins over restore', async () => {
  const first = makeStore();
  await first().initializeBcfAutosave();
  first().setBcfProject(project('Old'));
  await first().flushBcfAutosave();
  const next = makeStore();
  const restoring = next().initializeBcfAutosave();
  const closing = next().clearBcfProject();
  await restoring;
  assert.equal(await closing, true);
  assert.equal(next().bcfProject, null);
  const last = makeStore();
  await last().initializeBcfAutosave();
  assert.equal(last().bcfProject, null);
});

test('#10975 coalesces a burst of edits and skips selection-only changes', async ({ mock }) => {
  const live = makeStore();
  await live().initializeBcfAutosave();
  live().setBcfProject(project('Working'));
  await live().flushBcfAutosave();
  const first = await slot();
  const topic = createBCFTopic({ title: 'First', author: 'reviewer@example.com' });
  mock.timers.enable({ apis: ['setTimeout'] });
  live().addTopic(topic);
  mock.timers.tick(400);
  live().updateTopic(topic.guid, { title: 'Last' });
  mock.timers.tick(499);
  assert.deepEqual(await slot(), first);
  assert.equal(live().bcfAutosaveStatus, 'pending');
  mock.timers.tick(1);
  // The timer owns the write; wait for its asynchronous IndexedDB commit.
  for (let i = 0; i < 20 && live().bcfAutosaveStatus === 'pending'; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(live().bcfAutosaveStatus, 'saved');
  const last = await slot();
  assert.notDeepEqual(last, first);
  live().setActiveTopic(null);
  mock.timers.tick(500);
  assert.deepEqual(await slot(), last);
  const next = makeStore();
  await next().initializeBcfAutosave();
  assert.equal(next().bcfProject?.topics.get(topic.guid)?.title, 'Last');
});

test('#10975 preserves unreadable bytes through startup, edits and close', async () => {
  const damaged = { revision: 'saved', data: '{"version":2}' };
  await slot({ value: damaged });
  const next = makeStore();
  assert.equal(await next().initializeBcfAutosave(), false);
  assert.equal(next().bcfProject, null);
  next().setBcfProject(project('Memory only'));
  assert.equal(await next().flushBcfAutosave(), false);
  assert.equal(next().bcfAutosaveStatus, 'unreadable');
  assert.equal(await next().clearBcfProject(), false);
  assert.equal(next().bcfProject?.name, 'Memory only');
  assert.deepEqual(await slot(), damaged);
});

test('#10975 quota and image limit refusals preserve the previous commit', async ({ mock }) => {
  const live = makeStore();
  await live().initializeBcfAutosave();
  live().setBcfProject(project('Committed'));
  assert.equal(await live().flushBcfAutosave(), true);
  const before = await slot();

  const put = mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    // Adding at the existing key produces a real asynchronous request failure and rollback.
    const request = this.add(value, key);
    request.addEventListener('error', () => {
      Object.defineProperty(request, 'error', { value: new DOMException('Storage full', 'QuotaExceededError') });
    });
    return request;
  });
  try {
    live().setBcfProject(project('In memory'));
    assert.equal(await live().flushBcfAutosave(), false);
    assert.equal(live().bcfAutosaveStatus, 'quota');
    assert.equal(live().bcfProject?.name, 'In memory');
    assert.deepEqual(await slot(), before);
    assert.equal(await live().clearBcfProject(), false);
    assert.equal(live().bcfProject?.name, 'In memory', 'a refused close keeps the project available for export');
    assert.deepEqual(await slot(), before);
  } finally { put.mock.restore(); }

  const topic = createBCFTopic({ title: 'Large capture', author: 'reviewer@example.com' });
  live().addTopic(topic);
  live().addViewpoint(topic.guid, { guid: 'large', snapshotData: new Uint8Array(25 * 1024 * 1024) });
  assert.equal(await live().flushBcfAutosave(), false);
  assert.equal(live().bcfAutosaveStatus, 'too-large');
  assert.deepEqual(await slot(), before);
  live().deleteViewpoint(topic.guid, 'large');
  assert.equal(await live().flushBcfAutosave(), true);
  assert.equal(await live().clearBcfProject(), true, 'close succeeds after storage recovers');
  assert.equal(live().bcfProject, null);
});
