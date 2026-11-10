/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Leave while a local geometry edit is still being shared with the room.
 *
 * `mirrorEntityCreate` / `mirrorEntityGeometry` push the new mesh blob
 * fire-and-forget, and report a failure as `collabGeometryNotice` ("could not
 * be shared with the room"). A Leave in the middle retires the join: its
 * session is disposed (so the write throws) and its blob store is dropped. That
 * is the user leaving, not a failed share, and the room it names is no longer
 * theirs, so it must not surface as a notice after they left.
 *
 * Drives the REAL `startCollab` / `mirrorEntityGeometry` / `stopCollab`
 * against the real collab runtime (fake-indexeddb), with the fixture model
 * registered as the room's model.
 */

import 'fake-indexeddb/auto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCollabTestState } from '../../test/collab-slice-state.js';
import { roomSlotRef } from '@/lib/collab/model-slot-ref.js';
import { seedFixtureMesh, seedFixtureStore } from '../../test/collab-seed-fixture.js';

/** Long enough for an IndexedDB blob-store open plus one upload to settle. */
const SETTLE_MS = 500;

async function joinedOwnerWithRoomModel() {
  const s = buildCollabTestState();
  s.get().upsertModel({
    id: 'model-1',
    name: 'fixture.ifc',
    ifcDataStore: seedFixtureStore(),
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 2,
  });
  await s.get().startCollab({ roomId: 'upload-room', role: 'admin', token: 't', seed: { models: [] } });
  assert.notEqual(s.get().collabSession?.clientId ?? null, null, 'the join committed a session');
  // The fixture model is the room's model, slot m0.
  s.set({ collabRoomModels: new Map([['model-1', roomSlotRef(0)]]) });
  return s;
}

describe('collabSlice — Leave during a geometry upload', () => {
  it('a resize upload in flight when the user leaves raises no "could not be shared" notice', async () => {
    const s = await joinedOwnerWithRoomModel();
    try {
      // Starts the upload; its first await (the blob store) is still pending
      // when the user leaves on the very next line.
      s.get().mirrorEntityGeometry('model-1', 1, [seedFixtureMesh(1)]);
      s.get().stopCollab();
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      assert.equal(s.get().collabGeometryNotice, null);
      assert.equal(s.get().collabRoomId, null);
    } finally {
      s.get().stopCollab();
    }
  });

  it('a create upload in flight when the user leaves raises no notice either', async () => {
    const s = await joinedOwnerWithRoomModel();
    try {
      s.get().mirrorEntityCreate('model-1', 1, 'IFCWALL', null, seedFixtureMesh(1));
      s.get().stopCollab();
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      assert.equal(s.get().collabGeometryNotice, null);
    } finally {
      s.get().stopCollab();
    }
  });
});
