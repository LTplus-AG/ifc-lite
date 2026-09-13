/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * MAJOR (CodeRabbit CLI, PR #2706 review): fail closed when `startCollab`
 * runs with no active model.
 *
 * `ShareDialog` awaits `mintRoomToken()` and does not re-check cancellation
 * before calling `startCollab`. If the user removes the last model during
 * that await, `startCollab` is invoked with `activeModelId === null`. This
 * file drives the REAL `startCollab` (collabSlice.ts) under exactly that
 * precondition — not a stand-in — and pins its synchronous prefix:
 *
 *   const roomModels = new Map(); seed?.models.forEach(…roomSlotRef(index)…);
 *   set({ ..., collabRoomId: roomId, collabRoomModels: roomModels, ... });
 *
 * runs BEFORE any await, so by the time `startCollab` returns control to its
 * caller, `collabRoomId` (live-session marker) is already set while
 * `collabRoomModels` is empty (#4444: the share scope had no model left).
 * `room-model-target.ts`'s resolvers must fail closed in that state — pinned
 * separately, behaviourally, in `room-model-target.test.ts` and
 * `room-model-gate.test.ts`.
 *
 * What this does NOT drive: `ShareDialog`'s own missing cancellation check
 * (that the effect calls `startCollab` at all after the model disappeared),
 * or the rest of `startCollab` past the first `await import('@ifc-lite/collab')`
 * — the collab runtime needs IndexedDB/websocket wiring this harness does not
 * set up, and is irrelevant here: the corruption in `roomStoreFor` et al. is
 * fully determined by the synchronous prefix pinned below, which does not
 * depend on session bring-up succeeding or failing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isRoomModel, roomStoreFor } from '../../lib/collab/room-model-target.js';
import { buildCollabTestState } from '../../test/collab-slice-state.js';

describe('collabSlice.startCollab — entry race (model removed before the call)', () => {
  it('records a live session (collabRoomId set) with no room models, and the resolvers fail closed', () => {
    const s = buildCollabTestState();

    // The precondition: no model was ever loaded, or the last one was removed
    // — either way `activeModelId` is null, matching the state `startCollab`
    // observes when it races `ShareDialog`'s unguarded post-await call.
    assert.equal(s.get().activeModelId, null);

    // Call WITHOUT awaiting: an async function body runs synchronously up to
    // its first `await`, and the mutation this test pins happens before that
    // point (before `await import('@ifc-lite/collab')`). So by the time this
    // call returns (a Promise, not yet settled), the state below already
    // reflects the real `startCollab` prefix having run.
    const pending = s.get().startCollab({
      roomId: 'r1',
      role: 'admin',
      token: 'test-token',
      // Owner path (`seed` present) with the share scope emptied by the race.
      seed: { models: [] },
    });
    // The session bring-up past this point needs a real collab runtime this
    // harness does not provide; let it settle (success or failure) without
    // leaving an unhandled rejection, but the assertions below do not depend
    // on its outcome.
    pending.catch(() => {});

    assert.notEqual(s.get().collabRoomId, null, 'a live session must be recorded (this is the entry-race precondition)');
    assert.equal(s.get().collabRoomModels.size, 0, 'no model existed, so the room has no models');

    // The bug this pins shut: the OLD resolver could not tell "no session"
    // apart from "live session, models not yet known" and fell back to
    // `activeModelId` — which, if the user loads a private file next, would
    // silently become the (wrong) room model. Must fail closed instead.
    s.get().upsertModel({
      id: 'loaded-later',
      name: 'loaded-later.ifc',
      ifcDataStore: { schemaVersion: 'IFC4' } as never,
      geometryResult: null,
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: 0,
      fileSize: 0,
      idOffset: 0,
      maxExpressId: 0,
    });
    assert.equal(s.get().activeModelId, 'loaded-later', 'the private file is now active');
    assert.equal(isRoomModel(s.get(), 'loaded-later'), false);
    assert.equal(roomStoreFor(s.get(), 'loaded-later'), null);
  });
});
