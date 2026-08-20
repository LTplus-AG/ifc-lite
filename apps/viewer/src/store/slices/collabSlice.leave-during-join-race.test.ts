/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Async-interleaving defect: `stopCollab()` racing an in-flight `startCollab`.
 *
 * `startCollab` guards its await points against a *newer* start/stop
 * happening while it was suspended — six separate `get().collabRoomId ===
 * roomId` / `!== roomId` checks between the session-creation call and the
 * end of the function (collabSlice.ts, roughly lines 729-1090). But the
 * FINAL block — `remoteApplyTeardown = attachRemoteApply(...)`, the
 * annotation-sync wiring, and the closing
 * `set({ collabSession: session, collabConnecting: false, ... })` — has no
 * such guard. It runs unconditionally once the seed/reconstruct branch
 * above it returns, however long that took.
 *
 * `collabRoomId` is set SYNCHRONOUSLY at the top of `startCollab`, before
 * any await, so `RoomPanel` (apps/viewer/src/components/viewer/RoomPanel.tsx)
 * renders its "Leave" button immediately — while the join is still
 * mid-flight, awaiting `session.whenSynced`. A user who clicks Leave right
 * then runs `stopCollab()` (RoomPanel.tsx:198-201), which tears down the
 * (still empty) module-level session-adjacent state and clears
 * `collabRoomId`/`collabSession`. `startCollab`'s suspended continuation
 * then resumes, sails past the missing guard, and its closing `set()`
 * revives `collabSession` as if the user were still in the room — a session
 * the user explicitly left is now live, with a remote-apply listener wired
 * to it that nothing will ever tear down (the next `stopCollab()` disposes
 * the CURRENT `collabSession`, but the teardown closures this stale
 * continuation just installed are the ones now in the module-level
 * `remoteApplyTeardown`/`annotationInboundTeardown` slots — self-consistent
 * with itself, just not with the user's "I left" action).
 *
 * Proof technique: this drives the REAL `startCollab`/`stopCollab`
 * (collabSlice.ts) against a REAL `@ifc-lite/collab` session (real Y.Doc,
 * real IndexedDB persistence via `fake-indexeddb` — no server URL, so no
 * websocket). A `node:module` loader hook registered by THIS FILE ONLY
 * (isolated to this test's own process; node:test runs each file in its own
 * process) wraps `createCollabSession` so the test can pause the real
 * session's `whenSynced` at a chosen point and resume it explicitly — the
 * deterministic substitute for "the network happened to take a while".
 * Ordering is controlled entirely by promise resolution, not timers: the
 * test calls `stopCollab()` while `startCollab` is provably parked on the
 * gated `whenSynced`, THEN releases the gate, THEN awaits `startCollab`'s
 * own promise to completion.
 */

import 'fake-indexeddb/auto';
import { register } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

register('./collab-session-race-hook.mjs', import.meta.url);

import { createModelSlice, type ModelSlice, type ModelCrossSliceState } from './modelSlice.js';
import { createDataSlice, type DataSlice, type DataCrossSliceState } from './dataSlice.js';
import { createCollabSlice, type CollabSlice } from './collabSlice.js';
import type { ViewerState } from '../index.js';

type TestState = ModelSlice &
  ModelCrossSliceState &
  DataSlice &
  DataCrossSliceState &
  CollabSlice & {
    setEditEnabled: (enabled: boolean) => void;
    mutationViews: Map<string, unknown>;
  };

function buildState() {
  let state: TestState;
  const setState = (partial: unknown) => {
    const updates =
      typeof partial === 'function'
        ? (partial as (s: TestState) => Partial<TestState>)(state)
        : (partial as Partial<TestState>);
    state = { ...state, ...updates };
  };
  const getState = () => state as unknown as ViewerState;

  const modelSlice = createModelSlice(
    setState as Parameters<typeof createModelSlice>[0],
    getState as Parameters<typeof createModelSlice>[1],
    undefined as unknown as Parameters<typeof createModelSlice>[2],
  );
  const dataSlice = createDataSlice(
    setState as Parameters<typeof createDataSlice>[0],
    getState as Parameters<typeof createDataSlice>[1],
    undefined as unknown as Parameters<typeof createDataSlice>[2],
  );
  const collabSlice = createCollabSlice(
    setState as Parameters<typeof createCollabSlice>[0],
    getState as Parameters<typeof createCollabSlice>[1],
    undefined as unknown as Parameters<typeof createCollabSlice>[2],
  );

  state = {
    ...modelSlice,
    ...dataSlice,
    ...collabSlice,
    setEditEnabled: () => {},
    mutationViews: new Map(),
    pinboardEntities: new Set(),
    hierarchyBasketSelection: new Set(),
  } as TestState;

  return {
    get: () => state,
  };
}

describe('collabSlice — stopCollab() racing an in-flight startCollab()', () => {
  it('does not revive collabSession after the user left mid-join', async () => {
    let releaseGate!: () => void;
    (globalThis as { __collabSyncGate?: Promise<void> }).__collabSyncGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let sessionGated!: () => void;
    const sessionGatedPromise = new Promise<void>((resolve) => {
      sessionGated = resolve;
    });
    (globalThis as { __collabSessionGated?: () => void }).__collabSessionGated = sessionGated;

    const s = buildState();

    // Owner path, `seed: () => null` — a legitimate "nothing to seed" share
    // (matches ShareDialog's real usage) that skips the heavy
    // parse/hydrate/blob-store machinery entirely, isolating the race to
    // exactly the gap this test targets: the unguarded tail after
    // `await session.whenSynced`.
    const pending = s.get().startCollab({
      roomId: 'room-1',
      role: 'viewer',
      token: 'test-token',
      seed: () => null,
    });

    // Real session creation (real Y.Doc, real fake-indexeddb open) has to
    // actually happen before the gate is reached. Wait on the hook's own
    // signal rather than guessing a delay: `__collabSessionGated` fires
    // synchronously, from inside the wrapped `createCollabSession`, at the
    // exact moment `session.whenSynced` becomes the gated promise — so by
    // the time this resolves, `startCollab` is provably parked there.
    await sessionGatedPromise;

    // Precondition: the join is still recorded as live and in flight —
    // `startCollab` is parked on the gated `whenSynced`, past the
    // session-creation guard, short of the final `set()`.
    assert.equal(s.get().collabRoomId, 'room-1');
    assert.equal(s.get().collabConnecting, true);
    assert.equal(s.get().collabSession, null, 'the tail set() has not run yet');

    // The user clicks "Leave" in RoomPanel while still joining.
    s.get().stopCollab();
    assert.equal(s.get().collabRoomId, null, 'stopCollab cleared the room synchronously');
    assert.equal(s.get().collabSession, null);

    // Now let the parked startCollab continuation resume.
    releaseGate();
    await pending;

    // Always release the real IndexedDB connection this test opened —
    // whether or not the assertions below throw — so the process doesn't
    // hang on an open handle.
    try {
      // THE BUG: a session the user explicitly left is live again.
      assert.equal(
        s.get().collabSession,
        null,
        'a join the user cancelled before it finished must not become a live session afterward',
      );
      assert.equal(s.get().collabRoomId, null, 'must not silently re-enter the abandoned room');
    } finally {
      s.get().collabSession?.dispose();
    }
  });
});
