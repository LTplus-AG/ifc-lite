/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `dataSlice.meshColorBackup` holds each element's ORIGINAL colour so
 * `resetMeshColors` can put it back after a SET_COLORS override. It was cleared
 * in exactly one place, `resetMeshColors` itself, and in no teardown path.
 *
 * Its keys are global express ids, and those are REUSED across a model swap, so
 * a backup that outlives its model does not go inert: it names live elements of
 * the next one. `resetMeshColors` then queues the departed model's colours into
 * `pendingMeshColorUpdates`, which the renderer uploads.
 *
 * The map is also first-write-wins (`if (!meshColorBackup.has(id))` in
 * `updateMeshColors`), so a single leaked entry is permanent: a later override
 * on the NEW model declines to record that element's real colour, and every
 * reset from then on restores the old one. One stale entry corrupts the feature
 * for the rest of the session, not just for one reset.
 *
 * These run against the REAL combined store, same harness shape as
 * `clearAllModels-overlay-stale.test.ts` and the `removeModel-*-stale` family.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { useViewerStore } from './index.js';
import type { CameraRotation } from './types.js';
import type { FederatedModel } from './types.js';

/** Same shape the `removeModel-*-stale` siblings use: the id RANGES are what
 *  `resolveGlobalIdInModel` reads, so a stub without them makes every scoped
 *  purge a silent no-op and the test pass for the wrong reason. */
function model(id: string, idOffset: number, maxExpressId: number): FederatedModel {
  return { id, name: id, visible: true, idOffset, maxExpressId } as unknown as FederatedModel;
}

type Colour = [number, number, number, number];

const RED: Colour = [1, 0, 0, 1];
const GREEN: Colour = [0, 1, 0, 1];
const BLUE: Colour = [0, 0, 1, 1];

const meshOf = (expressId: number, color: Colour) => ({
  expressId,
  color,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  ifcType: 'IfcWall',
});

/** Load a model whose entity 12 has `color`, then override it, which is what
 *  captures the ORIGINAL into the backup. */
function loadAndOverride(color: Colour): void {
  const s = useViewerStore.getState();
  s.setGeometryResult({ meshes: [meshOf(12, color)] } as never);
  s.updateMeshColors(new Map([[12, GREEN]]), { override: true });
}

describe('meshColorBackup does not outlive the model it describes', () => {
  beforeEach(() => {
    useViewerStore.setState({ meshColorBackup: null, pendingMeshColorUpdates: null } as never);
  });

  it('resetViewerState drops it, so a swapped-in model keeps its own colours', () => {
    loadAndOverride(RED);
    assert.deepStrictEqual(
      [...(useViewerStore.getState().meshColorBackup ?? [])],
      [[12, RED]],
      'the override should have captured the original red',
    );

    // The primary-load swap path: reset, drop the geometry, load a new model
    // whose entity 12 is a DIFFERENT colour.
    useViewerStore.getState().resetViewerState();
    assert.strictEqual(
      useViewerStore.getState().meshColorBackup,
      null,
      'the previous model’s backup survived the reset',
    );

    useViewerStore.getState().setGeometryResult({ meshes: [meshOf(12, BLUE)] } as never);
    useViewerStore.getState().resetMeshColors();

    const queued = useViewerStore.getState().pendingMeshColorUpdates;
    assert.strictEqual(
      queued === null || !queued.has(12),
      true,
      `RESET_COLORS queued ${JSON.stringify(queued ? [...queued] : null)} for the new model; `
        + 'a red entry here is the previous model’s colour being uploaded to this one',
    );
  });

  it('a geometry REPLACE drops it, and a redundant set of the same object does not', () => {
    // The path CodeRabbit named and the three teardown clears do not cover:
    // `useIfcFederation` calls `setGeometryResult` on an ACTIVE-MODEL SWITCH,
    // with no reset and no removal, so the backup outlived the swap there too.
    loadAndOverride(RED);
    assert.deepStrictEqual([...(useViewerStore.getState().meshColorBackup ?? [])], [[12, RED]]);

    useViewerStore.getState().setGeometryResult({ meshes: [meshOf(12, BLUE)] } as never);
    assert.strictEqual(useViewerStore.getState().meshColorBackup, null, 'the replace should have dropped it');

    // And the new model's own override is now recordable. Before the fix the
    // stale entry made this a no-op, because the map is first-write-wins.
    useViewerStore.getState().updateMeshColors(new Map([[12, GREEN]]), { override: true });
    assert.deepStrictEqual(
      [...(useViewerStore.getState().meshColorBackup ?? [])],
      [[12, BLUE]],
      'the new model’s original colour should be what gets backed up',
    );

    // A redundant set of the SAME object must not destroy a live undo. This is
    // the mistake the removeModel clear made in its first draft.
    const same = useViewerStore.getState().geometryResult;
    useViewerStore.getState().setGeometryResult(same);
    assert.deepStrictEqual([...(useViewerStore.getState().meshColorBackup ?? [])], [[12, BLUE]]);
  });

  it('removeModel purges only the removed model’s entries', () => {
    // Scoped, not wholesale. `unregisterModel` BURNS the removed range rather
    // than reclaiming it, so a surviving model can never be handed these ids
    // and its own undo has to survive. Dropping the map whole left the store
    // and the GPU permanently out of step, with no action left to reconcile
    // them: `resetMeshColors` had nothing to restore from.
    loadAndOverride(RED);
    const backup = useViewerStore.getState().meshColorBackup;
    assert.ok(backup, 'the override should have populated the backup');
    assert.strictEqual(backup.has(12), true);

    // 'gone' owns [0, 1000] so it owns id 12; 'kept' owns [900000, 901000].
    useViewerStore.setState({
      meshColorBackup: new Map([...backup, [900_500, BLUE]]),
      models: new Map([
        ['gone', model('gone', 0, 1_000)],
        ['kept', model('kept', 900_000, 1_000)],
      ]),
    } as never);

    useViewerStore.getState().removeModel('gone');

    const after = useViewerStore.getState().meshColorBackup;
    assert.ok(after, 'the surviving model’s entry was dropped with the removed model’s');
    // Both halves. Without the first, removing the purge entirely still passes;
    // without the second, purging wholesale still passes.
    assert.strictEqual(after.has(12), false, 'the removed model’s entry should be gone');
    assert.strictEqual(after.has(900_500), true, 'the surviving model’s entry should remain');
  });

  it('clearAllModels drops it', () => {
    loadAndOverride(RED);
    useViewerStore.getState().clearAllModels();
    assert.strictEqual(useViewerStore.getState().meshColorBackup, null);
  });
});

describe('a camera rotation accepted before the renderer registers is replayed', () => {
  it('does not report success for a rotation that never reached the camera', () => {
    // The embed bridge acks SET_CAMERA and returns regardless of whether
    // `Viewport`'s effect has registered its callbacks yet. Before this, the
    // pose was recorded in state and never actuated: success reported for
    // something that did not happen.
    useViewerStore.setState({ cameraCallbacks: {}, pendingCameraRotation: null } as never);

    useViewerStore.getState().setCameraRotation({ azimuth: 120, elevation: 30 });
    assert.deepStrictEqual(
      useViewerStore.getState().pendingCameraRotation,
      { azimuth: 120, elevation: 30 },
      'a rotation with no actuator should be held for replay',
    );

    const seen: CameraRotation[] = [];
    useViewerStore.getState().setCameraCallbacks({
      setCameraRotation: (r: CameraRotation) => { seen.push(r); },
    } as never);

    assert.deepStrictEqual(seen, [{ azimuth: 120, elevation: 30 }], 'registration should replay it');
    assert.strictEqual(useViewerStore.getState().pendingCameraRotation, null, 'and clear it');
  });

  it('does not replay one that already actuated', () => {
    // The control: with an actuator present the command took effect, so there
    // is nothing pending and registering a second renderer must not re-fire it.
    const first: CameraRotation[] = [];
    useViewerStore.setState({ pendingCameraRotation: null } as never);
    useViewerStore.getState().setCameraCallbacks({
      setCameraRotation: (r: CameraRotation) => { first.push(r); },
    } as never);

    useViewerStore.getState().setCameraRotation({ azimuth: 45, elevation: 10 });
    assert.strictEqual(first.length, 1);
    assert.strictEqual(useViewerStore.getState().pendingCameraRotation, null);

    const second: CameraRotation[] = [];
    useViewerStore.getState().setCameraCallbacks({
      setCameraRotation: (r: CameraRotation) => { second.push(r); },
    } as never);
    assert.deepStrictEqual(second, [], 'an already-applied rotation must not replay');
  });
});
