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
      deletePropertySet: (..._a: unknown[]) => { calls.push('deletePropertySet'); return mutation; },
      setEntityType: (..._a: unknown[]) => { calls.push('setEntityType'); return mutation; },
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

  it('editor/admin: a DELETE commits too, not just the gate letting it past', () => {
    // github.com/LTplus-AG/ifc-lite/issues/2765: making `deleteProperty` a
    // no-op immediately AFTER the gate left 4 tests green. Every assertion on
    // it was in the viewer-role case, where `null` is the CORRECT answer, so
    // "the gate rejects it" and "the action does nothing at all" produced the
    // same observable result and only one of them is right.
    const { spy, state } = buildSlice(true);
    const s = state();

    assert.notStrictEqual(s.deleteProperty('m1', 1, 'Pset_Test', 'P'), null);

    assert.deepStrictEqual(spy.calls, ['deleteProperty'], 'the delete reaches the local view');
    assert.ok(
      (state() as unknown as { dirtyModels: Set<string> }).dirtyModels.has('m1'),
      'a delete dirties the model like any other edit',
    );
    assert.ok(
      ((state() as unknown as { undoStacks: Map<string, unknown[]> }).undoStacks.get('m1') ?? []).length > 0,
      'a delete is undoable',
    );
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

/**
 * The rest of the slice's writers, enumerated rather than sampled.
 *
 * The gate had been added one call site at a time — `setProperty`, then
 * `deleteProperty`/`setAttribute`/`createPropertySet`, then
 * `setQuantity`/`createQuantitySet` ("This was missing here", says that one's
 * own comment) — and each round left the arms nobody happened to look at open.
 * `deletePropertySet` sat directly beneath a gated `createPropertySet`, with a
 * byte-for-byte identical body minus the gate. `setEntityType` sat beneath a
 * gated `setAttribute`. `duplicateEntity` creates an entity the way `addWall`
 * does, and that path is gated. The three `split*` tools write the way
 * `resizeWall` does, and that one is gated.
 *
 * So this suite is written as a LIST, and the list is the point: a new writer
 * added to the slice should be added here, and it will be red until it is
 * gated. Sampling one or two is what let the gap survive three rounds of
 * fixing.
 *
 * `roleCanEdit(null) === true`, so none of this touches single-user sessions.
 */
describe('mutationSlice -- every writer is role-gated, not just the sampled ones', () => {
  const ROLE_REASON = 'Editing is disabled for your role in this shared session';

  it('viewer role: pset/type writes reject WITHOUT touching the local view', () => {
    const { spy, state } = buildSlice(false);
    const s = state();

    assert.strictEqual(
      s.deletePropertySet('m1', 1, 'Pset_Test'),
      null,
      'deletePropertySet must be gated like its createPropertySet sibling',
    );
    assert.strictEqual(
      s.setEntityType('m1', 1, 'IfcSlab'),
      null,
      'setEntityType must be gated like its setAttribute sibling',
    );
    assert.strictEqual(
      s.setPositionalAttribute('m1', 1, 3, 'x'),
      null,
      'setPositionalAttribute is the rawest write in the slice',
    );

    // Returning null while having already written locally would be the same
    // divergence with the symptom hidden, so the view is what is asserted on.
    assert.deepStrictEqual(spy.calls, [], 'no write may reach the local view');
    assert.strictEqual((state() as unknown as { mutationVersion: number }).mutationVersion, 0);
    assert.strictEqual((state() as unknown as { dirtyModels: Set<string> }).dirtyModels.size, 0);
  });

  /**
   * These reject for a second reason too in this harness (no model / no store),
   * so the RETURNED REASON is what is asserted, not merely that they failed.
   * Asserting "it returned an error" would pass against the ungated code and
   * pin nothing.
   */
  it('viewer role: creation and geometry tools reject FOR THE ROLE REASON', () => {
    const { state } = buildSlice(false);
    const s = state();

    assert.deepStrictEqual(
      s.duplicateEntity('m1', 1),
      { error: ROLE_REASON },
      'duplicateEntity creates an entity, like the gated addWall/addColumn',
    );

    const splits: [string, { ok: boolean; reason?: string }][] = [
      ['splitWallAtDistance', s.splitWallAtDistance('m1', 1, 0.5)],
      ['splitLinearElementAtDistance', s.splitLinearElementAtDistance('m1', 1, 0.5)],
      ['splitSlabByLine', s.splitSlabByLine('m1', 1, [0, 0], [1, 1])],
    ];
    for (const [name, res] of splits) {
      assert.deepStrictEqual(
        res,
        { ok: false, reason: ROLE_REASON },
        `${name} must be gated like its resizeWall sibling, and say so`,
      );
    }
  });

  /**
   * The gate must be the ONLY thing these tests are sensitive to. An editor
   * role has to get past it and fail (or succeed) on the real reason instead --
   * otherwise a gate that rejected everyone would satisfy the suite above.
   */
  it('editor role: the same calls get past the gate and fail on their own terms', () => {
    const { spy, state } = buildSlice(true);
    const s = state();

    assert.notStrictEqual(s.deletePropertySet('m1', 1, 'Pset_Test'), null);
    assert.notStrictEqual(s.setEntityType('m1', 1, 'IfcSlab'), null);
    assert.deepStrictEqual(spy.calls, ['deletePropertySet', 'setEntityType']);

    const dup = s.duplicateEntity('m1', 1) as { error?: string };
    assert.notStrictEqual(dup.error, ROLE_REASON, 'an editor is past the role gate');

    const split = s.splitWallAtDistance('m1', 1, 0.5) as { ok: boolean; reason?: string };
    assert.strictEqual(split.ok, false, 'still fails -- there is no model in this harness');
    assert.notStrictEqual(split.reason, ROLE_REASON, 'but not for the role reason');
  });
});
