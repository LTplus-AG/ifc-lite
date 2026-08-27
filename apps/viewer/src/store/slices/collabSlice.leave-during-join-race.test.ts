/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Async-interleaving defect: `stopCollab()` racing an in-flight `startCollab`.
 *
 * `startCollab` guards its await points against a *newer* start/stop
 * happening while it was suspended — a dozen separate `get().collabRoomId
 * === roomId` / `!== roomId` checks between the session-creation call and
 * the end of the function (collabSlice.ts). But the
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

register('../../test/collab-session-race-hook.mjs', import.meta.url);

import { createModelSlice, type ModelSlice } from './modelSlice.js';
import { createDataSlice, type DataSlice, type DataCrossSliceState } from './dataSlice.js';
import { createCollabSlice, type CollabSlice } from './collabSlice.js';
import type { ViewerState } from '../index.js';

type TestState = ModelSlice &
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
    // uiSlice's real action is not under test; `startCollab` only calls it
    // when `canCollabEdit()` is false, which is not this test's path
    // (role: 'admin'), but it must exist to type-check the call site.
    setEditEnabled: () => {},
    mutationViews: new Map(),
    // Fields other slices own that the teardown `removeModel` dispatches
    // reads off this stub state (`store/teardown-registry.ts`). Every
    // contribution falls back to its own initial value when a field is
    // absent, so these are here to make the harness store-shaped rather than
    // to satisfy a type. Same enumeration as the sibling
    // `collabSlice.entry-race.test.ts`; keep the two in step.
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

  return {
    get: () => state,
  };
}

/**
 * Await `p`, or fail with a message naming what did not happen.
 *
 * This test has TWO places it can park forever, and until #3054 they were
 * indistinguishable: both surfaced as `testTimeoutFailure ... 120000ms` with
 * no indication of which. That cost a day. Three separate structural
 * explanations were proposed and argued for the same hang — a specifier that
 * never reached the loader hook, a leave path that never resolved, an
 * IndexedDB open that never returned — and the output was byte-identical
 * under all three, so it could not rule out any of them.
 *
 * The cause is fixed. This is not a fix for it; it is what makes the NEXT hang
 * here cost a message instead of an investigation. A test that parks forever
 * on any upstream failure will park again.
 *
 * The timer is CLEARED on the fast path but deliberately NOT unref'd, and that
 * distinction is the whole helper. An unref'd timer cannot keep the event loop
 * alive, so when the awaited promise is the only other pending work — exactly
 * the case this exists to report — Node drains the loop and exits before the
 * timer can fire. The run then dies with `Promise resolution is still pending
 * but the event loop has already resolved`, which is another anonymous
 * failure, and the named message never appears.
 *
 * That was not reasoned: the first version had `unref()`, and a standalone
 * test of this helper caught it, 3 of 4 red. A diagnostic that breaks the
 * thing it diagnoses is worse than none.
 *
 * `clearTimeout` in `finally` is what stops a 30s timer outliving a fast pass.
 *
 * What this does NOT do, measured rather than assumed: it does not make a
 * wedged run exit. In the "continuation never resumes" case the session object
 * is reachable only from the parked `startCollab` closure — `collabSession` is
 * still null, so `dispose()` is a no-op and the IndexedDB handle stays open.
 * The message is printed at 30s either way, which is the whole point; the
 * process lingering afterwards is unchanged from before.
 *
 * The gate case is the opposite; see the call site, which explains why the
 * whole test body sits inside one try/finally.
 */
async function within<T>(p: Promise<T>, ms: number, expected: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${expected}`)), ms);
  });
  try {
    return await Promise.race([p, expiry]);
  } finally {
    // Unconditional: the Promise executor runs synchronously so `timer` is
    // always assigned, and `clearTimeout` accepts undefined anyway. A falsy
    // guard could only ever skip cleanup for a handle of 0.
    clearTimeout(timer);
  }
}

/**
 * Well under node:test's 120s cap so this fires first and names the cause, and
 * far above anything a real Y.Doc plus fake-indexeddb open takes even on a
 * loaded runner, so it cannot flake into a false diagnosis.
 */
const GATE_TIMEOUT_MS = 30_000;

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
    // the time this resolves WITH 'gated', `startCollab` is provably parked
    // there. It can now also resolve with 'returned-early', which means the
    // opposite, and only the assert below tells the two apart.
    // Everything from here is inside one try/finally so the IndexedDB
    // connection is released whichever wait gives up. In the gate case
    // `startCollab` can run to completion and store a LIVE session before this
    // times out, so the dispose genuinely fires and the run exits.
    try {
      // Raced against `pending` itself, not awaited alone. `startCollab`
      // CATCHES everything from the dynamic import through
      // `createCollabSession` and returns normally, so a failed bring-up
      // resolves `pending` and simply never fires the gate. Waiting on the gate
      // alone would sit for the full timeout and then blame the loader hook —
      // a confident wrong answer, and the exact failure this helper exists to
      // prevent. Measured: with `globalThis.indexedDB` cleared, the wrap DID
      // apply and the old message still said it had not.
      const outcome = await within(
        Promise.race([
          sessionGatedPromise.then(() => 'gated' as const),
          pending.then(() => 'returned-early' as const),
        ]),
        GATE_TIMEOUT_MS,
        'the session to be gated OR startCollab to return (neither happened, so nothing ' +
          'is running — suspect the loader hook or a wait with no timeout upstream)',
      );
      assert.equal(
        outcome,
        'gated',
        'startCollab returned before the session was gated, so bring-up failed or finished ' +
          'early and swallowed its error — the [collab] diagnostic logged above is the real ' +
          'cause, NOT the loader hook',
      );

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

      await within(
        pending,
        GATE_TIMEOUT_MS,
        // Deliberately names BOTH remaining candidates. The gate signal fires
        // from the `whenSynced` GETTER, so it proves only that the getter was
        // read — it says nothing about the real `whenSynced` behind it ever
        // resolving. Claiming "the session path is fine" here would exonerate
        // a suspect this signal cannot clear.
        'startCollab to resume after releaseGate() (the gate was read and released, so the ' +
          'loader hook applied — suspect the real whenSynced never settling, or the tail ' +
          'after it never returning)',
      );

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
