/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * First slice of github.com/LTplus-AG/ifc-lite/issues/2802: `collabSlice` is
 * 1300 lines wired into the store and, until this file, **no test called
 * `createCollabSlice` at all**. Replacing `get().activeModelId` with a garbage
 * literal left 60/60 green and `tsc` clean.
 *
 * That matters more here than the line count suggests. This is the slice the
 * #2790 outage lived in — a failed share reported success for weeks — and the
 * two things covered here are the ones other code TRUSTS:
 *
 *   - `canCollabEdit` / `canCollabComment` are the authorisation answer
 *     `mutationSlice` gates every write on. Wrong in the permissive direction
 *     and a viewer-role user accumulates local edits that never reach the room;
 *     wrong in the restrictive direction and single-user editing breaks
 *     entirely.
 *   - every `mirror*` is documented "no-ops without an active session". Nothing
 *     tested that, and it is what makes them safe to call unconditionally from
 *     the mutation path in single-user mode.
 *
 * The async half (`startCollab`'s session lifecycle, the recipient reconstruct)
 * still has no coverage and is not attempted here: it needs a live
 * `CollabSession`. This file deliberately takes the synchronous surface that
 * needs no session, rather than claiming the whole slice.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCollabSlice, type CollabRole, type CollabSlice } from './collabSlice.js';
import type { ViewerState } from '../index.js';

/**
 * Build the slice over a mock store. The slice reaches across to other slices
 * (`models`, `ifcDataStore`, `setEditEnabled`), so those are stubbed to the
 * minimum the synchronous paths touch.
 */
function buildSlice(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let state: Record<string, unknown> = {
    models: new Map(),
    activeModelId: null,
    ifcDataStore: null,
    setEditEnabled: (on: boolean) => calls.push(`setEditEnabled(${on})`),
    upsertModel: () => calls.push('upsertModel'),
    updateModel: () => calls.push('updateModel'),
    removeModel: () => calls.push('removeModel'),
    setIfcDataStore: () => calls.push('setIfcDataStore'),
    setGeometryResult: () => calls.push('setGeometryResult'),
    ...overrides,
  };
  const setState = (partial: unknown) => {
    const patch =
      typeof partial === 'function'
        ? (partial as (s: Record<string, unknown>) => Record<string, unknown>)(state)
        : (partial as Record<string, unknown>);
    state = { ...state, ...patch };
  };
  const slice = createCollabSlice(
    setState as never,
    (() => state) as never,
    {} as never,
  ) as CollabSlice;
  state = { ...slice, ...state };
  return {
    calls,
    get: () => state as unknown as ViewerState & CollabSlice,
    setRole: (collabRole: CollabRole | null) => {
      state = { ...state, collabRole };
    },
  };
}

describe('collabSlice: the role gate every write is checked against', () => {
  /** The whole matrix, in one place. A role missing here is a role nothing pins. */
  const CASES: ReadonlyArray<readonly [CollabRole | null, boolean, boolean]> = [
    // role, canEdit, canComment
    [null, true, true], // single-user: no room, so no collab restriction applies
    ['viewer', false, false],
    ['commenter', false, true],
    ['editor', true, true],
    ['admin', true, true],
  ];

  for (const [role, canEdit, canComment] of CASES) {
    it(`${role ?? 'no room'}: edit=${canEdit} comment=${canComment}`, () => {
      const s = buildSlice();
      s.setRole(role);
      assert.equal(s.get().canCollabEdit(), canEdit);
      assert.equal(s.get().canCollabComment(), canComment);
    });
  }

  it('treats "no room" as allowed rather than as a missing permission', () => {
    // The distinction the null case encodes: outside a shared room the local
    // single-user editing rules apply, so a collab gate returning false here
    // would silently disable editing for every user who never shares anything.
    const s = buildSlice();
    s.setRole(null);
    assert.equal(s.get().canCollabEdit(), true, 'single-user editing must not be gated by collab');
  });

  it('does not let a commenter write the model', () => {
    // The pair that is easiest to get wrong, asserted against each other: a
    // commenter may write comments and must not write the model.
    const s = buildSlice();
    s.setRole('commenter');
    assert.equal(s.get().canCollabComment(), true);
    assert.equal(s.get().canCollabEdit(), false);
  });
});

describe('collabSlice: mirrors are inert in a single-user store', () => {
  // Every mirror is called unconditionally by the mutation path, so in
  // single-user mode they must be silent and harmless. That is the contract
  // `mutationSlice` relies on, and nothing tested it.
  //
  // WHAT THIS CANNOT DISTINGUISH, stated because the obvious reading is wrong:
  // each mirror guards on `!session || !store || !docApi`, and `docApi` is a
  // MODULE-scoped binding that only `startCollab` ever sets. Outside a session
  // it is null, so it is the binding guard here — verified by mutation:
  // forcing `session` truthy leaves these tests green, because `docApi` still
  // stops the call.
  //
  // So this pins "the mirrors are inert outside a session", NOT "the session
  // check specifically is what stops them". Isolating the three conditions
  // needs a live `CollabSession` to bind `docApi`, which is the untested async
  // surface #2802 leaves open. Naming the limit rather than letting the test
  // title imply cover it does not have.
  let s: ReturnType<typeof buildSlice>;

  beforeEach(() => {
    s = buildSlice();
  });

  it('property, attribute and annotation mirrors are silent no-ops', () => {
    const st = s.get();
    assert.equal(st.collabSession, null, 'precondition: no session');
    // The assertion that carries weight is `calls` staying empty below: it
    // proves nothing reached another slice, whichever guard did the stopping.
    st.mirrorPropertyEdit(1, 'Pset_Test', 'P', 'v', 0 as never);
    st.mirrorPropertyDelete(1, 'Pset_Test', 'P');
    st.mirrorAttributeEdit(1, 'Name', 'x');
    st.mirrorAnnotationUpsert({ id: 'a1' } as never);
    st.mirrorAnnotationDelete('a1');
    // Nothing reached the other slices, and nothing threw.
    assert.deepEqual(s.calls, []);
  });

  it('geometry and placement mirrors are silent no-ops', () => {
    const st = s.get();
    st.mirrorEntityRemove('m1', 1);
    st.mirrorPlacementEdit('m1', 1, [1, 0, 0]);
    st.mirrorEntityGeometry('m1', 1, { expressId: 1 } as never);
    assert.deepEqual(s.calls, []);
  });

  it('leaves the geometry notice channel empty when nothing happened', () => {
    // The notice is a one-shot for the toast surface; a mirror no-op must not
    // post one, or a single-user session would show collab errors.
    assert.equal(s.get().collabGeometryNotice, null);
    assert.equal(s.get().consumeCollabGeometryNotice(), null);
  });
});

describe('collabSlice: the one-shot geometry notice', () => {
  it('is delivered once and then cleared', () => {
    // Written for #2795: the joiner posts here when a room hydrates with
    // entities but no meshes, and the layout consumes it. Delivering twice
    // would double-toast; never clearing would re-toast on every re-render.
    const s = buildSlice({ collabGeometryNotice: 'geometry missing' });
    assert.equal(s.get().consumeCollabGeometryNotice(), 'geometry missing');
    assert.equal(s.get().collabGeometryNotice, null, 'consumed notices are cleared');
    assert.equal(s.get().consumeCollabGeometryNotice(), null, 'a second read gets nothing');
  });
});

describe('collabSlice: stopCollab returns the room state to rest', () => {
  it('clears every room-scoped field, including the seed failure', () => {
    // A field left behind here leaks into the NEXT room: a stale
    // `collabSeedFailure` would make a healthy share report the previous
    // room's failure, and a stale role would gate writes by an old permission.
    const s = buildSlice({
      collabRoomId: 'room-1',
      collabRole: 'viewer' as CollabRole,
      collabSelfToken: 'tok',
      collabLastShareToken: 'share-tok',
      collabSeedFailure: 'geometry upload failed',
      collabGeometryNotice: 'stale notice',
      collabPanelVisible: true,
      collabPeersSinceBaseline: true,
    });

    s.get().stopCollab();

    const after = s.get();
    assert.equal(after.collabRoomId, null);
    assert.equal(after.collabRole, null);
    assert.equal(after.collabSelfToken, null);
    assert.equal(after.collabLastShareToken, null);
    assert.equal(after.collabSeedFailure, null, 'a seed failure must not survive into the next room');
    assert.equal(after.collabGeometryNotice, null);
    assert.equal(after.collabStatus, 'disconnected');
    assert.deepEqual(after.collabPeers, []);
    assert.equal(after.collabPeersSinceBaseline, false);
  });

  it('is safe to call when no session was ever started', () => {
    // startCollab calls it first thing, so this is the ordinary path, not an
    // edge case.
    const s = buildSlice();
    s.get().stopCollab();
    assert.equal(s.get().collabRoomId, null);
  });
});
