/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `startCollab`'s own `try { ... } catch (err)` around session creation
 * (collabSlice.ts, roughly :562) resets `collabConnecting` and `collabStatus`
 * on failure, but not `collabRoomId` / `collabRole` / `collabSelfToken` —
 * all three set synchronously just before the try block, before any session
 * exists. If `collab.createCollabSession(...)` rejects (for example
 * `createIndexedDbProvider` throwing because `indexedDB` is undefined outside
 * a browser — exactly the Node test/CI environment), the slice is left with
 * `collabSession: null` but `collabRoomId` / `collabRole` / `collabSelfToken`
 * still naming the room that failed to start. Any UI keyed off "is
 * `collabRoomId` set" (the toolbar indicator, ShareDialog) reads this as
 * "still in the room", and `canCollabEdit()`/`canCollabComment()` — the gate
 * every write in mutationSlice is checked against — apply the failed room's
 * role instead of falling back to single-user rules.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCollabSlice, type CollabRole, type CollabSlice } from './collabSlice.js';
import type { ViewerState } from '../index.js';

function buildSlice(overrides: Record<string, unknown> = {}) {
  let state: Record<string, unknown> = {
    models: new Map(),
    activeModelId: null,
    ifcDataStore: null,
    setEditEnabled: () => {},
    upsertModel: () => {},
    updateModel: () => {},
    removeModel: () => {},
    setIfcDataStore: () => {},
    setGeometryResult: () => {},
    ...overrides,
  };
  const setState = (partial: unknown) => {
    const patch =
      typeof partial === 'function'
        ? (partial as (s: Record<string, unknown>) => Record<string, unknown>)(state)
        : (partial as Record<string, unknown>);
    state = { ...state, ...patch };
  };
  const slice = createCollabSlice(setState as never, (() => state) as never, {} as never) as CollabSlice;
  state = { ...slice, ...state };
  return { get: () => state as unknown as ViewerState & CollabSlice };
}

describe('collabSlice.startCollab — session-creation failure leaves stale room state', () => {
  it('resets collabRoomId/collabRole/collabSelfToken (not just collabStatus) when the session never comes up', async () => {
    // No global `indexedDB` in this Node test process, so the real
    // `@ifc-lite/collab#createCollabSession` (provider 'indexeddb', the
    // default with no configured collab server) rejects inside the awaited
    // dynamic import — driving startCollab's REAL catch path, not a stand-in.
    assert.equal(typeof (globalThis as { indexedDB?: unknown }).indexedDB, 'undefined');

    const s = buildSlice();
    await s.get().startCollab({ roomId: 'room-1', role: 'editor', token: 'tok' });

    const after = s.get();
    assert.equal(after.collabSession, null, 'no session was created');
    assert.equal(after.collabStatus, 'disconnected');
    assert.equal(after.collabConnecting, false);

    // The bug: these three were set (synchronously, before the try) to make
    // the join token available to early subscribers, and the failure path
    // never rolls them back.
    assert.equal(
      after.collabRoomId,
      null,
      'a room the session failed to join must not still be recorded as current',
    );
    assert.equal(
      after.collabRole,
      null as CollabRole | null,
      'a stale role gates canCollabEdit/canCollabComment as if a session were live',
    );
    assert.equal(after.collabSelfToken, null, 'a stale token must not survive a failed join');
  });
});
