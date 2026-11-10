/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Leave + rejoin of the SAME room while the first join is still in flight.
 *
 * `startCollab` used to recognise its own continuation by
 * `collabRoomId === roomId`. A rejoin of the same room sets the same id, so
 * the abandoned first attempt passed every re-check: it committed its own
 * session over the live join's, and its failure path cleared the live
 * join's room fields. Each join now carries its own attempt token.
 *
 * Driven through the REAL `startCollab` with the session-race loader hook:
 * `__collabCreateHold` parks (or fails) a `createCollabSession` call, and a
 * per-session `__collabSyncGate` parks its `whenSynced`.
 */

import 'fake-indexeddb/auto';
import { register } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

register('../../test/collab-session-race-hook.mjs', import.meta.url);

import { buildCollabTestState } from '../../test/collab-slice-state.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RaceHookGlobals {
  __collabSyncGate?: Promise<void>;
  __collabSessionGated?: () => void;
  __collabSessionCreated?: (session: { clientId: number; whenSynced: Promise<void> }) => void;
  __collabCreateHold?: () => Promise<void>;
}
const hook = globalThis as RaceHookGlobals;

const TIMEOUT_MS = 30_000;
async function within<T>(p: Promise<T>, expected: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** Arm the hook so the NEXT session's `whenSynced` parks on its own gate. */
function armSyncGate(): { release: () => void; gated: Promise<void> } {
  const gate = deferred<void>();
  const gated = deferred<void>();
  hook.__collabSyncGate = gate.promise;
  hook.__collabSessionGated = () => gated.resolve();
  return { release: () => gate.resolve(), gated: gated.promise };
}

function resetHook(): void {
  delete hook.__collabSyncGate;
  delete hook.__collabSessionGated;
  delete hook.__collabSessionCreated;
  delete hook.__collabCreateHold;
}

describe('collabSlice — leave and rejoin the same room mid-join', () => {
  it('a stale first join resuming after the rejoin does not commit its session', async () => {
    const created: number[] = [];
    // The session's own (ungated) sync, read before the hook gates it. Leave
    // disposes the first join's session, and a provider disposed before it
    // synced may never settle its sync; letting it sync first keeps the stale
    // continuation resumable, so the test can watch what it does on resuming.
    const ownSync: Promise<void>[] = [];
    hook.__collabSessionCreated = (session) => {
      created.push(session.clientId);
      ownSync.push(session.whenSynced);
    };
    const s = buildCollabTestState();
    try {
      const first = armSyncGate();
      const pendingFirst = s.get().startCollab({ roomId: 'room-1', role: 'admin', token: 't1', seed: { models: [] } });
      await within(first.gated, 'the first join to park on whenSynced');
      await within(ownSync[0], "the first session's own sync");

      s.get().stopCollab();
      const second = armSyncGate();
      const pendingSecond = s.get().startCollab({ roomId: 'room-1', role: 'admin', token: 't2', seed: { models: [] } });
      await within(second.gated, 'the rejoin to park on whenSynced');
      assert.equal(created.length, 2);

      // The abandoned first join resumes while the rejoin is still in flight.
      first.release();
      await within(pendingFirst, 'the stale first join to return');
      assert.equal(s.get().collabSession?.clientId ?? null, null, 'the stale join must not commit a session');
      assert.equal(s.get().collabRoomId, 'room-1');
      assert.equal(s.get().collabConnecting, true, 'the rejoin is still connecting');
      assert.equal(s.get().collabSelfToken, 't2');

      second.release();
      await within(pendingSecond, 'the rejoin to finish');
      assert.equal(s.get().collabSession?.clientId, created[1], 'the live session is the rejoin’s');
      assert.equal(s.get().collabConnecting, false);
    } finally {
      s.get().stopCollab();
      resetHook();
    }
  });

  it("a stale first join's failed start does not clear the rejoin's room", async () => {
    const created2: number[] = [];
    const s = buildCollabTestState();
    const firstHold = deferred<void>();
    try {
      // The first join parks inside createCollabSession, then fails there;
      // later calls pass straight through. Holds are handed out per call, in
      // call order, because the first join reaches createCollabSession only
      // after its own lazy import, i.e. after the rejoin below started.
      const holds = [firstHold.promise];
      hook.__collabCreateHold = () => holds.shift() ?? Promise.resolve();
      const pendingFirst = s.get().startCollab({ roomId: 'room-1', role: 'viewer', token: 't1', seed: { models: [] } });

      s.get().stopCollab();
      hook.__collabSessionCreated = (session) => created2.push(session.clientId);
      const second = armSyncGate();
      const pendingSecond = s.get().startCollab({ roomId: 'room-1', role: 'admin', token: 't2', seed: { models: [] } });
      await within(second.gated, 'the rejoin to park on whenSynced');

      firstHold.reject(new Error('relay refused the stale join'));
      await within(pendingFirst, 'the stale first join to return');
      assert.equal(s.get().collabRoomId, 'room-1', "the stale failure must not clear the rejoin's room");
      assert.equal(s.get().collabRole, 'admin');
      assert.equal(s.get().collabSelfToken, 't2');
      assert.equal(s.get().collabConnecting, true, 'the rejoin is still connecting');

      second.release();
      await within(pendingSecond, 'the rejoin to finish');
      assert.equal(s.get().collabSession?.clientId, created2[0]);
    } finally {
      s.get().stopCollab();
      resetHook();
    }
  });

  it('a stale first join whose session arrives after the rejoin disposes it and returns', async () => {
    const created: number[] = [];
    const s = buildCollabTestState();
    const firstHold = deferred<void>();
    try {
      // The first join's createCollabSession resolves only after the rejoin
      // is underway: its session arrives for an attempt already retired.
      const holds = [firstHold.promise];
      hook.__collabCreateHold = () => holds.shift() ?? Promise.resolve();
      hook.__collabSessionCreated = (session) => created.push(session.clientId);
      const pendingFirst = s.get().startCollab({ roomId: 'room-1', role: 'admin', token: 't1', seed: { models: [] } });

      s.get().stopCollab();
      const second = armSyncGate();
      const pendingSecond = s.get().startCollab({ roomId: 'room-1', role: 'admin', token: 't2', seed: { models: [] } });
      await within(second.gated, 'the rejoin to park on whenSynced');

      // Disarm the gate so the stale session, if it went on to await its own
      // sync, would not be parked by the hook but by its own disposal.
      delete hook.__collabSyncGate;
      firstHold.resolve();
      await within(pendingFirst, 'the stale first join to return');
      assert.equal(created.length, 2, 'both joins created a session');
      assert.equal(s.get().collabSession?.clientId ?? null, null, 'the stale join must not commit a session');
      assert.equal(s.get().collabConnecting, true, 'the rejoin is still connecting');

      second.release();
      await within(pendingSecond, 'the rejoin to finish');
      // The held first join created its session second.
      assert.equal(s.get().collabSession?.clientId, created[0]);
    } finally {
      s.get().stopCollab();
      resetHook();
    }
  });
});
