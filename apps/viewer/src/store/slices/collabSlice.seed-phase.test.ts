/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4446 — `collabSeedPhase` models the owner's initial seed as explicit state,
 * separate from connectivity.
 *
 * The defect: `startCollab` sets `collabRoomId` synchronously and the provider
 * reports `connected` long before structure and geometry are in the room, so
 * a Share dialog keyed on either handed out invites to rooms that were still
 * empty. Whoever opened one — including the owner navigating to their own
 * link — reconstructed 0 entities / 0 triangles.
 *
 * Proof technique: the REAL `startCollab` against a REAL `@ifc-lite/collab`
 * session (real Y.Doc, real IndexedDB via `fake-indexeddb`, real IndexedDB
 * blob store), with the loader hook from the leave-during-join race test
 * gating `whenSynced` so the test can observe the state between "room id set"
 * and "seed begun" deterministically. The hook also hands the real session out
 * so the doc can be read at the moment the phase says `ready` — which is the
 * moment the Share dialog mints the invite, and the moment the owner in the
 * issue's reproduction navigated away.
 */

import 'fake-indexeddb/auto';
import { register } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

register('../../test/collab-session-race-hook.mjs', import.meta.url);

import type { CollabSession } from '@ifc-lite/collab';
import { buildCollabTestState } from '../../test/collab-slice-state.js';
import { buildGeometryResultFromMeshes } from '@/lib/collab/geometry-sync.js';
import { roomSlotRef } from '@/lib/collab/model-slot-ref.js';
import type { CollabSeedPhase, CollabSeedProgress } from '@/lib/collab/seed-phase.js';
import { SEED_GUIDS, seedFixtureMesh, seedFixtureMeshes, seedFixtureStore } from '../../test/collab-seed-fixture.js';
import type { MeshData } from '@ifc-lite/geometry';

const TIMEOUT_MS = 30_000;

async function within<T>(p: Promise<T>, expected: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms waiting for ${expected}`)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

interface Trace {
  phase: CollabSeedPhase;
  sessionCommitted: boolean;
  status: string;
}

/** Owner join with the fixture model; records every phase transition. */
function ownerJoin(roomId: string, meshes: MeshData[]) {
  const trace: Trace[] = [];
  const s = buildCollabTestState({
    onSet: (before, after) => {
      if (after.collabSeedPhase !== before.collabSeedPhase) {
        trace.push({
          phase: after.collabSeedPhase,
          sessionCommitted: after.collabSession !== null,
          status: after.collabStatus,
        });
      }
    },
  });
  s.set({ geometryResult: buildGeometryResultFromMeshes(meshes) });
  const store = seedFixtureStore();
  let created: CollabSession | null = null;
  (globalThis as { __collabSessionCreated?: (session: CollabSession) => void }).__collabSessionCreated = (
    session,
  ) => {
    created = session;
  };
  const pending = s.get().startCollab({
    roomId,
    role: 'admin',
    token: 'admin-token',
    // One model, the m0 slot (#4444); its meshes are the owner's live geometry.
    seed: {
      models: [
        { modelId: 'model-1', name: 'fixture.ifc', store, isIfcx: false, meshes, idOffset: 0, schemaVersion: 'IFC4' },
      ],
    },
  });
  return { s, trace, pending, session: () => created };
}

describe('collabSlice — collabSeedPhase (#4446)', () => {
  it('goes syncing -> structure -> geometry -> ready, with the session committed only after, and the doc full at ready', async () => {
    let releaseGate!: () => void;
    (globalThis as { __collabSyncGate?: Promise<void> }).__collabSyncGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let sessionGated!: () => void;
    const gated = new Promise<void>((resolve) => {
      sessionGated = resolve;
    });
    (globalThis as { __collabSessionGated?: () => void }).__collabSessionGated = sessionGated;

    const { s, trace, pending, session } = ownerJoin('seed-phase-room-1', seedFixtureMeshes());
    try {
      // Before any await inside startCollab: the room id is public and so is
      // the pending seed — set in the SAME synchronous set(), so no subscriber
      // can see a room with nothing in flight.
      assert.equal(s.get().collabRoomId, 'seed-phase-room-1');
      assert.equal(s.get().collabSeedPhase, 'syncing');

      const outcome = await within(
        Promise.race([gated.then(() => 'gated' as const), pending.then(() => 'returned-early' as const)]),
        'the session to be gated OR startCollab to return',
      );
      assert.equal(outcome, 'gated', 'bring-up failed before the seed (see the [collab] diagnostic above)');

      // Parked on whenSynced: connected as far as the provider is concerned,
      // nothing in the room yet. This is the window the issue reproduced in.
      assert.equal(s.get().collabSeedPhase, 'syncing');
      assert.equal(s.get().collabSession, null);
      assert.equal(session()?.doc.getMap('entities').size, 0, 'the room is still empty here');

      // Resolve once the phase says ready — the moment the Share dialog mints.
      const ready = new Promise<void>((resolve) => {
        const original = s.hooks.onSet;
        s.hooks.onSet = (before, after) => {
          original?.(before, after);
          if (after.collabSeedPhase === 'ready') resolve();
        };
      });
      releaseGate();
      await within(ready, 'collabSeedPhase to reach ready');

      assert.deepEqual(
        Array.from(s.get().collabRoomModels.entries()),
        [['model-1', roomSlotRef(0)]],
        'the owner recorded its model under slot m0',
      );

      // The owner navigates away the instant the invite becomes available.
      s.get().stopCollab();

      // What the guest would find in the room at that instant: everything.
      const doc = session()!.doc;
      assert.equal(doc.getMap('entities').size, 2, 'both products are in the room when ready is reported');
      assert.equal(doc.getMap('geometry').size, 2, 'both meshes are referenced when ready is reported');
      // Loaded here, after `register()`, so it resolves through the same hook
      // as the slice's own lazy import.
      const { getGeometryRef, slotPath } = await import('@ifc-lite/collab');
      for (const guid of Object.values(SEED_GUIDS)) {
        assert.equal(getGeometryRef(doc, slotPath(roomSlotRef(0), guid))?.geomIds.length, 1, `${guid} carries its geometry ref`);
      }

      assert.deepEqual(
        trace.map((t) => t.phase),
        ['syncing', 'structure', 'geometry', 'confirming', 'ready', 'none'],
        'phases in order; the trailing none is stopCollab',
      );
      for (const t of trace.filter((t) => t.phase !== 'none')) {
        assert.equal(t.sessionCommitted, false, `collabSession is still null at ${t.phase}: it is not the readiness signal`);
      }
      const atReady = trace.find((t) => t.phase === 'ready');
      assert.deepEqual(s.get().collabSeedProgress, null, 'stopCollab cleared the progress row');
      assert.ok(atReady, 'ready was observed');

      await within(pending, 'startCollab to return after the leave');
      assert.equal(s.get().collabSession, null, 'the abandoned join did not revive a session');
      assert.equal(s.get().collabSeedPhase, 'none');
    } finally {
      s.get().collabSession?.dispose();
      session()?.dispose();
    }
  });

  it('records geometry progress and settles ready with no failure on a clean seed', async () => {
    delete (globalThis as { __collabSyncGate?: Promise<void> }).__collabSyncGate;
    const progress: CollabSeedProgress[] = [];
    const { s, pending, session } = ownerJoin('seed-phase-room-2', seedFixtureMeshes());
    const original = s.hooks.onSet;
    s.hooks.onSet = (before, after) => {
      original?.(before, after);
      if (after.collabSeedProgress && after.collabSeedProgress !== before.collabSeedProgress) {
        progress.push(after.collabSeedProgress);
      }
    };
    try {
      await within(pending, 'startCollab to complete');
      assert.equal(s.get().collabSeedPhase, 'ready');
      assert.equal(s.get().collabSeedFailure, null);
      assert.deepEqual(progress.at(-1), { uploaded: 2, total: 2, modelIndex: 0, modelCount: 1 });
      assert.ok(s.get().collabSession, 'the session is committed once the seed is done');
      assert.equal(s.get().collabStatus, 'indexeddb', 'status is the provider, not the seed');
    } finally {
      s.get().stopCollab();
      session()?.dispose();
    }
  });

  it('settles failed, with the owner-facing reason, when the geometry never makes it into the room', async () => {
    delete (globalThis as { __collabSyncGate?: Promise<void> }).__collabSyncGate;
    // A textured mesh whose image is unavailable fails its upload explicitly.
    const orphaned: MeshData = { ...seedFixtureMesh(1) };
    delete orphaned.texture;
    orphaned.textureRef = { textureId: 1, url: 'image.png', repeatS: true, repeatT: false };
    const { s, trace, pending, session } = ownerJoin('seed-phase-room-3', [orphaned]);
    try {
      await within(pending, 'startCollab to complete');
      assert.equal(s.get().collabSeedPhase, 'failed');
      assert.match(s.get().collabSeedFailure ?? '', /no 3D geometry|source image is unavailable/);
      assert.deepEqual(trace.map((t) => t.phase), ['syncing', 'structure', 'geometry', 'confirming', 'failed'], 'even a failed seed confirms what it did write before settling');
      assert.equal(session()?.doc.getMap('geometry').size, 0);
    } finally {
      s.get().stopCollab();
      session()?.dispose();
    }
  });
});
