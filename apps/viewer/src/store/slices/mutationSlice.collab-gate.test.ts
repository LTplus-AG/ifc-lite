/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collab role gate on property mutations (PR #1692 review follow-up).
 *
 * In a shared session, only editor/admin may write. The gate must run BEFORE
 * the local MutablePropertyView commit — otherwise a viewer-role user's edit
 * lands in the local view/undo/dirty state but never syncs to the room, and
 * the model silently diverges. Single-user sessions (collab role === null)
 * must be completely unaffected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createMutationSlice, type MutationSlice } from './mutationSlice.js';
import type { ViewerState } from '../index.js';

/** Records the first argument every `mirror*` call was handed. */
type MirrorCall = { name: string; modelId: unknown };

/** Minimal MutablePropertyView double that records writes. */
function makeViewSpy() {
  const calls: string[] = [];
  const mutation = { id: 'mut_test', type: 'UPDATE_PROPERTY', timestamp: 0, modelId: 'm1', entityId: 1 };
  return {
    calls,
    view: {
      setProperty: (..._a: unknown[]) => { calls.push('setProperty'); return mutation; },
      deleteProperty: (..._a: unknown[]) => { calls.push('deleteProperty'); return mutation; },
      setAttribute: (..._a: unknown[]) => { calls.push('setAttribute'); return mutation; },
      createPropertySet: (..._a: unknown[]) => { calls.push('createPropertySet'); return mutation; },
      setQuantity: (..._a: unknown[]) => { calls.push('setQuantity'); return mutation; },
      createQuantitySet: (..._a: unknown[]) => { calls.push('createQuantitySet'); return mutation; },
    },
  };
}

/**
 * Build the mutation slice on a mock combined state with an injectable
 * collab role. Mirrors the buildSlice pattern in uiSlice.edit-mode.test.ts.
 */
function buildSlice(canEdit: boolean, editedModelId = 'm1') {
  const spy = makeViewSpy();
  const mirrors: MirrorCall[] = [];
  let state: Record<string, unknown> = {
    models: new Map(),
    // Deliberately NOT the edited model in the wiring tests below: a room's
    // mirror gates on the modelId it is handed, so handing it the active model
    // instead of the edited one re-opens the corruption.
    activeModelId: 'active-not-edited',
    mutationViews: new Map([[editedModelId, spy.view]]),
    undoStacks: new Map(),
    redoStacks: new Map(),
    dirtyModels: new Set(),
    mutationVersion: 0,
    canCollabEdit: () => canEdit,
    // Mirrors are cross-slice; the role gate under test runs before they would.
    // Each records the modelId it was handed — see the wiring suite below.
    mirrorPropertyEdit: (modelId: unknown) => {
      mirrors.push({ name: 'mirrorPropertyEdit', modelId });
    },
    mirrorPropertyDelete: (modelId: unknown) => {
      mirrors.push({ name: 'mirrorPropertyDelete', modelId });
    },
    mirrorAttributeEdit: (modelId: unknown) => {
      mirrors.push({ name: 'mirrorAttributeEdit', modelId });
    },
  };
  const setState = (partial: unknown) => {
    const updates =
      typeof partial === 'function'
        ? (partial as (s: Record<string, unknown>) => Record<string, unknown>)(state)
        : (partial as Record<string, unknown>);
    state = { ...state, ...updates };
  };
  const getState = () => state as unknown as ViewerState;
  const slice = createMutationSlice(
    setState as never,
    getState as never,
    {} as never,
  ) as MutationSlice;
  state = { ...slice, ...state };
  return { spy, mirrors, state: () => state as unknown as ViewerState & MutationSlice };
}

describe('mutationSlice — collab role gate on property mutations', () => {
  it('viewer role: property writes are rejected BEFORE touching the local view', () => {
    const { spy, state } = buildSlice(false);
    const s = state();
    assert.strictEqual(s.setProperty('m1', 1, 'Pset_Test', 'P', 'v'), null);
    assert.strictEqual(s.deleteProperty('m1', 1, 'Pset_Test', 'P'), null);
    assert.strictEqual(s.setAttribute('m1', 1, 'Name', 'x'), null);
    assert.strictEqual(s.createPropertySet('m1', 1, 'Pset_New', []), null);
    assert.deepStrictEqual(spy.calls, [], 'local view must not be written for a read-only role');
    assert.strictEqual((state() as unknown as { mutationVersion: number }).mutationVersion, 0);
    assert.strictEqual((state() as unknown as { dirtyModels: Set<string> }).dirtyModels.size, 0);
  });

  it('editor/admin (and single-user, role null): property writes commit locally', () => {
    const { spy, state } = buildSlice(true);
    const s = state();
    assert.notStrictEqual(s.setProperty('m1', 1, 'Pset_Test', 'P', 'v'), null);
    assert.notStrictEqual(s.setAttribute('m1', 1, 'Name', 'x'), null);
    assert.deepStrictEqual(spy.calls, ['setProperty', 'setAttribute']);
    assert.ok((state() as unknown as { dirtyModels: Set<string> }).dirtyModels.has('m1'));
  });
});

/**
 * The room gate lives inside each `mirror*` action, keyed on the modelId it is
 * handed (`roomStoreFor`, lib/collab/room-model-target.ts). That makes the call
 * site's one remaining job load-bearing: it must pass the model the edit was
 * made ON. Passing the ACTIVE model instead is the corruption this PR fixes,
 * re-introduced one level up — a user who joins a room and then loads and
 * selects their own file has a different model active, and the gate would then
 * approve mirroring their private edit into the shared room.
 *
 * So `activeModelId` here is deliberately NOT the edited model: any call site
 * that reaches for it turns these red.
 */
describe('mutationSlice — mirrors are handed the EDITED model, not the active one', () => {
  it('setProperty / deleteProperty / setAttribute each forward their own modelId', () => {
    const { mirrors, state } = buildSlice(true, 'edited');
    const s = state();

    s.setProperty('edited', 1, 'Pset_Test', 'P', 'v');
    s.deleteProperty('edited', 1, 'Pset_Test', 'P');
    s.setAttribute('edited', 1, 'Name', 'x');

    assert.deepStrictEqual(
      mirrors,
      [
        { name: 'mirrorPropertyEdit', modelId: 'edited' },
        { name: 'mirrorPropertyDelete', modelId: 'edited' },
        { name: 'mirrorAttributeEdit', modelId: 'edited' },
      ],
      'each mirror must receive the model the edit was made on',
    );
    // Stated separately so a future call site that reads `activeModelId`
    // fails on the reason rather than on a diff of two lists.
    for (const call of mirrors) {
      assert.notStrictEqual(
        call.modelId,
        'active-not-edited',
        `${call.name} was handed the ACTIVE model — that is the corruption path`,
      );
    }
  });

  /**
   * The mirrors are called unconditionally now (the gate moved into them), so
   * a read-only role must still be stopped by the role gate before any of them
   * is reached — otherwise moving the room gate would have quietly widened the
   * role gate's hole.
   */
  it('viewer role: no mirror is reached at all', () => {
    const { mirrors, state } = buildSlice(false, 'edited');
    const s = state();
    s.setProperty('edited', 1, 'Pset_Test', 'P', 'v');
    s.deleteProperty('edited', 1, 'Pset_Test', 'P');
    s.setAttribute('edited', 1, 'Name', 'x');
    assert.deepStrictEqual(mirrors, []);
  });

  /**
   * `readCollabPlacement` is the placement half of the same rule, and the one
   * that was ungated when this PR was first pushed. `readEntityPosition` is the
   * GizmoOverlay's "is this entity movable?" gate and `readEntityRotation` the
   * rotate card's, so handing either the ACTIVE model would put the move gizmo
   * on a PRIVATE model's entities — and dragging it runs the write.
   *
   * Both reach the collab fallback here because the model has no registered
   * `ifcDataStore`, which is the real "no STEP chain" branch: with no store
   * there is nothing for `resolvePlacementChain` to walk.
   */
  it('readEntityPosition / readEntityRotation forward their own modelId to readCollabPlacement', () => {
    const seen: unknown[] = [];
    const { state } = buildSlice(true, 'edited');
    (state() as unknown as Record<string, unknown>).readCollabPlacement = (modelId: unknown) => {
      seen.push(modelId);
      return null;
    };
    const s = state();

    s.readEntityPosition('edited', 1);
    s.readEntityRotation('edited', 1);

    assert.deepStrictEqual(
      seen,
      ['edited', 'edited'],
      'the placement read must name the model the entity id came from',
    );
  });
});

/**
 * `setQuantity` / `createQuantitySet` carried NEITHER the `canCollabEdit()`
 * gate NOR a `mirror*` call, unlike every other mutation kind above.
 *
 * The gate half is fixed: they now reject a viewer-role writer like their
 * siblings. `setProperty`'s own comment gives the reason -- a viewer-role user
 * must not accumulate local-only edits that silently never reach the room.
 *
 * The MIRROR half is NOT fixed and is pinned as a known gap. There is no
 * `mirrorQuantityEdit` in this codebase at all, and `attachRemoteApply`'s
 * inbound observer has no branch for the CRDT's `quantities` map key (only
 * `attributes` and `psets`), even though `packages/collab`'s schema defines
 * `ENTITY_KEY.QUANTITIES` with working `setQuantityValue`/`deleteQuantityValue`
 * accessors. So an EDITOR's quantity edit still reaches no peer: no error, no
 * warning, nothing observable short of comparing Qtos across peers by hand.
 *
 * Wiring that is a multi-file feature (bridge `CollabDocApi` +
 * `RemoteApplyHandlers` + `attachRemoteApply` + `collabSlice` + this slice),
 * so it is documented here rather than half-built. The second test pins the
 * current no-mirror behaviour so closing the gap is a visible, deliberate
 * diff against this file.
 */
describe('mutationSlice -- quantity mutations are role-gated; mirroring is a known gap', () => {
  it('viewer role: quantity writes are rejected, like every other mutation kind', () => {
    const { spy, state } = buildSlice(false);
    const s = state();
    assert.strictEqual(
      s.setQuantity('m1', 1, 'Qto_WallBaseQuantities', 'Length', 3),
      null,
      'a viewer role must not commit a quantity edit',
    );
    assert.strictEqual(
      s.createQuantitySet('m1', 1, 'Qto_New', [{ name: 'Length', value: 3, quantityType: 0 }]),
      null,
    );
    // The underlying view must never be touched: returning null while still
    // having written locally would be the same divergence, just hidden.
    assert.deepStrictEqual(spy.calls, []);
  });

  it('editor role: quantity writes commit locally but still mirror nothing (known gap)', () => {
    const { spy, state } = buildSlice(true);
    const s = state();
    assert.notStrictEqual(s.setQuantity('m1', 1, 'Qto_WallBaseQuantities', 'Length', 3), null);
    assert.deepStrictEqual(spy.calls, ['setQuantity'], 'local view IS written');
    // No `mirror*` action exists for quantities to call, so there is nothing
    // to assert was invoked. That absence IS the gap: a remote peer never
    // sees this edit.
  });
});
