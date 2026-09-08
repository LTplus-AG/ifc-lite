/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Leaving a room mid-join must not leave the reconstructed `room:<id>` model
 * behind. (#3016)
 *
 * The recipient path registers a real model record for the room, and installs
 * `recipientLiveTeardown` — which removes it — only AFTER `await reconstruct()`
 * has returned. The abandoned-join guard added by #3011 sits below that
 * assignment and returns without running it, so a Leave landing in that window
 * left the model in `models` until the next `stopCollab`.
 *
 * Proof technique, following `collabSlice.leave-during-join-race.test.ts`: the
 * REAL `startCollab`/`stopCollab` over a REAL `@ifc-lite/collab` session (real
 * Y.Doc, `fake-indexeddb`, no server URL so no websocket). A loader hook
 * registered by THIS FILE ONLY parks the reconstruct at
 * `hydrateGeometryFromRoom`, the one await that sits after the model is
 * registered and before the guard. Ordering is promise resolution, not timers.
 */

import 'fake-indexeddb/auto';
import { register } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

register('../../test/collab-hydrate-gate-hook.mjs', import.meta.url);

import type { ModelSlice } from './modelSlice.js';
import type { DataSlice, DataCrossSliceState } from './dataSlice.js';
import type { CollabSlice } from './collabSlice.js';
import type { ViewerState } from '../index.js';

type TestState = ModelSlice &
  DataSlice &
  DataCrossSliceState &
  CollabSlice & {
    setEditEnabled: (enabled: boolean) => void;
    mutationViews: Map<string, unknown>;
  };

/**
 * Built through dynamic imports so the whole slice graph — including the
 * statically imported `@/lib/collab/geometry-sync` — is loaded AFTER
 * `register()` above. A static import here would be hoisted past it and the
 * hook would never see the module.
 */
async function buildState() {
  const { createModelSlice } = await import('./modelSlice.js');
  const { createDataSlice } = await import('./dataSlice.js');
  const { createCollabSlice } = await import('./collabSlice.js');

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
    addElementModelId: null,
    addElementStoreyId: null,
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    selectedStoreys: new Set(),
    hiddenEntities: new Set(),
    isolatedEntities: null,
    ghostExceptEntities: null,
    classFilter: null,
    hiddenEntitiesByModel: new Map(),
    isolatedEntitiesByModel: new Map(),
    pinboardEntities: new Set(),
    hierarchyBasketSelection: new Set(),
  } as TestState;

  return { get: () => state };
}

interface Gate {
  /** Resolves once the join has parked at `hydrateGeometryFromRoom`. */
  atGate: Promise<void>;
  release: () => void;
}

/**
 * Park the next `count` recipient reconstructs at `hydrateGeometryFromRoom`,
 * one gate each, so overlapping joins can be released in a chosen order.
 */
function gateHydrate(count = 1): Gate[] {
  const g = globalThis as {
    __collabHydrateGates?: Promise<void>[];
    __collabHydrateGated?: (index: number) => void;
    __collabHydrateCalls?: number;
  };
  const gates: Gate[] = [];
  const promises: Promise<void>[] = [];
  const reached: Array<() => void> = [];
  for (let i = 0; i < count; i += 1) {
    let release!: () => void;
    promises.push(new Promise<void>((resolve) => {
      release = resolve;
    }));
    let signal!: () => void;
    const atGate = new Promise<void>((resolve) => {
      signal = resolve;
    });
    reached.push(signal);
    gates.push({ atGate, release });
  }
  g.__collabHydrateGates = promises;
  g.__collabHydrateCalls = 0;
  g.__collabHydrateGated = (index) => reached[index]?.();
  return gates;
}

describe('collabSlice — leaving after the room model was reconstructed', () => {
  it('does not leave an orphan room:<id> model behind', { timeout: 60_000 }, async () => {
    const [{ atGate, release }] = gateHydrate();
    const s = await buildState();

    // Recipient path: no `seed`, so `startCollab` reconstructs the model from
    // the (empty) CRDT and registers it as `room:<roomId>`.
    const pending = s.get().startCollab({
      roomId: 'room-3016',
      role: 'viewer',
      token: 'test-token',
    });

    await atGate;

    // Precondition: the model this test is about really exists, and the join
    // is still in flight.
    assert.ok(
      s.get().models.has('room:room-3016'),
      'the recipient model was never registered — this test would pass vacuously',
    );
    assert.equal(s.get().collabRoomId, 'room-3016');

    // The user clicks "Leave" while the reconstruct is still finishing.
    s.get().stopCollab();
    assert.equal(s.get().collabRoomId, null, 'stopCollab cleared the room synchronously');

    release();
    await pending;

    try {
      assert.equal(
        s.get().models.has('room:room-3016'),
        false,
        'the room model outlived the session the user left',
      );
    } finally {
      s.get().collabSession?.dispose();
    }
  });

  it('leaves a model the session did not create alone', { timeout: 60_000 }, async () => {
    const [{ atGate, release }] = gateHydrate();
    const s = await buildState();

    // A model of the user's own, loaded before the join and untouched by it.
    s.get().upsertModel({
      id: 'local-file',
      name: 'my.ifc',
      visible: true,
      collapsed: false,
      loadedAt: Date.now(),
      fileSize: 0,
      idOffset: 0,
      maxExpressId: 0,
      loadState: 'complete',
    } as Parameters<TestState['upsertModel']>[0]);

    const pending = s.get().startCollab({
      roomId: 'room-3016b',
      role: 'viewer',
      token: 'test-token',
    });

    await atGate;
    s.get().stopCollab();
    release();
    await pending;

    try {
      assert.ok(
        s.get().models.has('local-file'),
        'leaving a room removed a model that had nothing to do with it',
      );
    } finally {
      s.get().collabSession?.dispose();
    }
  });

  it('does not disarm the teardown of the room the user moved on to', { timeout: 60_000 }, async () => {
    // Two joins overlap: the first is abandoned mid-reconstruct, the second
    // completes and installs its own teardown in the module-level slot BEFORE
    // the first's continuation reaches the abandoned-join guard. The stale
    // continuation must clean up after itself without touching the live
    // session's cleanup — the model of the room the user is now in has to
    // survive, and its removal on the eventual Leave must still happen.
    const [first, second] = gateHydrate(2);
    const s = await buildState();

    const abandoned = s.get().startCollab({
      roomId: 'room-old',
      role: 'viewer',
      token: 'test-token',
    });
    await first.atGate;
    s.get().stopCollab();

    // The recipient path reconstructs only when there is no local store; the
    // first join left one behind. Clearing it puts the state back in the shape
    // a second deep-link join starts from, so the second join really registers
    // its own room model — without this the test parks forever waiting for a
    // reconstruct that never runs.
    s.get().setIfcDataStore(null);

    const live = s.get().startCollab({
      roomId: 'room-new',
      role: 'viewer',
      token: 'test-token',
    });
    await second.atGate;
    second.release();
    await live;

    assert.equal(s.get().collabRoomId, 'room-new');
    assert.ok(s.get().models.has('room:room-new'), 'the second join registered its model');

    // Only now does the abandoned join resume and hit the guard.
    first.release();
    await abandoned;

    try {
      assert.ok(
        s.get().models.has('room:room-new'),
        'the abandoned join tore down the room the user is actually in',
      );
      assert.equal(
        s.get().models.has('room:room-old'),
        false,
        'the abandoned join left its own room model behind',
      );

      // And the live session's own teardown is still armed: leaving now must
      // remove its model.
      s.get().stopCollab();
      assert.equal(
        s.get().models.has('room:room-new'),
        false,
        'the live session lost its teardown to the abandoned join',
      );
    } finally {
      s.get().collabSession?.dispose();
    }
  });
});
