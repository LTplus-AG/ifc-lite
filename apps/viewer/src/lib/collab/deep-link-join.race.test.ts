/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { register } from 'node:module';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { CollabSession } from '@ifc-lite/collab';
import { buildCollabTestState } from '@/test/collab-slice-state';
import { joinRoomFromPageUrl } from './deep-link-join';
import { setCollabEnabledOverride } from './config';
import { openProcessedModel, resetProcessedModelRequestsForTests } from '@/lib/processed-model';
register('../../test/collab-session-race-hook.mjs', import.meta.url);

it('leaves a page room parked at sync when a host request arrives, without hydration or seeding', async () => {
  const globals = globalThis as typeof globalThis & {
    __collabSyncGate?: Promise<void>;
    __collabSessionGated?: () => void;
    __collabSessionCreated?: (session: CollabSession) => void;
  };
  let release!: () => void;
  let gated!: () => void;
  let session: CollabSession | undefined;
  let ownSync: Promise<void> | undefined;
  globals.__collabSyncGate = new Promise<void>(resolve => { release = resolve; });
  const atSync = new Promise<void>(resolve => { gated = resolve; });
  globals.__collabSessionGated = gated;
  globals.__collabSessionCreated = value => { session = value; ownSync = value.whenSynced; };
  const state = buildCollabTestState();
  let pending!: Promise<void>;
  setCollabEnabledOverride(true);
  try {
    joinRoomFromPageUrl('?room=host-race', opts => {
      pending = state.get().startCollab(opts);
      return pending;
    }, state.get().stopCollab);
    await Promise.race([atSync, pending.then(() => { throw new Error('join returned before sync gate'); })]);
    await ownSync;
    assert.equal(state.get().collabConnecting, true);
    let roomWrites = 0;
    session!.doc.on('update', () => { roomWrites++; });
    openProcessedModel({ sha256: 'a'.repeat(64), bytes: 1, name: 'host.ifc' });
    assert.equal(state.get().collabRoomId, null, 'the pending room is left synchronously');
    release();
    await pending;
    assert.equal(state.get().collabSession, null);
    assert.equal(state.get().models.size, 0, 'no room model hydrated');
    assert.equal(roomWrites, 0, 'no host data or annotations seeded into the room');
  } finally {
    release();
    state.get().stopCollab();
    session?.dispose();
    delete globals.__collabSyncGate;
    delete globals.__collabSessionGated;
    delete globals.__collabSessionCreated;
    resetProcessedModelRequestsForTests();
    setCollabEnabledOverride(null);
  }
});
