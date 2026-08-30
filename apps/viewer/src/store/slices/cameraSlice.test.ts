/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `setCameraRotation` must ACTUATE, not just record.
 *
 * It used to be `set({ cameraRotation })` and nothing else, while its one
 * caller — the embed bridge's `SET_CAMERA` handler — acked the command as
 * successful and the outbound `CAMERA_CHANGED` echoed the host's own numbers
 * straight back. Every success signal, no camera movement (#2934). The
 * recording proxy over `cameraCallbacks` below is the same probe that showed
 * zero callbacks being invoked; it now pins the opposite.
 *
 * `setProjectionMode` in this same slice is the established shape: drive the
 * callback, then store the state.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { cameraTeardown, createCameraSlice, type CameraSlice } from './cameraSlice.js';
import { CAMERA_DEFAULTS } from '../constants.js';

describe('cameraSlice', () => {
  let state: CameraSlice;
  let calls: Array<[string, unknown]>;

  function build(withCallbacks: boolean): void {
    calls = [];
    const set = (
      partial: Partial<CameraSlice> | ((s: CameraSlice) => Partial<CameraSlice>),
    ) => {
      const updates = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...updates };
    };
    const get = () => state;
    state = createCameraSlice(set as never, get as never, undefined as never);
    if (withCallbacks) {
      state = {
        ...state,
        // Recording proxy over the callback surface the Viewport registers.
        cameraCallbacks: {
          setCameraRotation: (rotation) => calls.push(['setCameraRotation', rotation]),
          setProjectionMode: (mode) => calls.push(['setProjectionMode', mode]),
          setInteractionMode: (mode) => calls.push(['setInteractionMode', mode]),
        },
      };
    }
  }

  beforeEach(() => build(true));

  describe('setCameraRotation', () => {
    it('drives the renderer through cameraCallbacks.setCameraRotation', () => {
      state.setCameraRotation({ azimuth: 120, elevation: 30 });

      assert.deepStrictEqual(calls, [['setCameraRotation', { azimuth: 120, elevation: 30 }]]);
    });

    it('still records the rotation in the store', () => {
      state.setCameraRotation({ azimuth: 120, elevation: 30 });

      assert.deepStrictEqual(state.cameraRotation, { azimuth: 120, elevation: 30 });
    });

    it('records the rotation even when no renderer has registered yet', () => {
      // cameraCallbacks is `{}` until the Viewport mounts; the store write must
      // not depend on the actuator existing.
      build(false);

      state.setCameraRotation({ azimuth: 15, elevation: 5 });

      assert.deepStrictEqual(state.cameraRotation, { azimuth: 15, elevation: 5 });
      assert.deepStrictEqual(calls, []);
    });

    it('starts from the shared camera defaults', () => {
      assert.deepStrictEqual(state.cameraRotation, {
        azimuth: CAMERA_DEFAULTS.AZIMUTH,
        elevation: CAMERA_DEFAULTS.ELEVATION,
      });
    });
  });

  describe('setInteractionMode', () => {
    it('drives the renderer through cameraCallbacks.setInteractionMode', () => {
      state.setInteractionMode('pan');

      assert.deepStrictEqual(calls, [['setInteractionMode', 'pan']]);
      assert.strictEqual(state.interactionMode, 'pan');
    });

    it('defers via pendingInteractionMode when no renderer has registered yet, and replays on setCameraCallbacks', () => {
      build(false);

      state.setInteractionMode('none');

      assert.deepStrictEqual(calls, []);
      assert.strictEqual(state.pendingInteractionMode, 'none');

      state.setCameraCallbacks({
        setInteractionMode: (mode) => calls.push(['setInteractionMode', mode]),
      });

      assert.deepStrictEqual(calls, [['setInteractionMode', 'none']]);
      assert.strictEqual(state.pendingInteractionMode, null);
    });

    it('defaults to unrestricted (\'all\')', () => {
      assert.strictEqual(state.interactionMode, 'all');
    });
  });

  // `?controls=` is read once per embed session and `Viewport` stays mounted
  // across a file swap, so nothing re-applies the param and nothing restores
  // the default when the next URL omits it. Without the teardown owning these
  // two fields, the outgoing model's restriction governed the incoming one.
  describe('session-reset teardown (#2934 review)', () => {
    it('clears interactionMode and pendingInteractionMode', () => {
      build(false);
      state.setInteractionMode('none');
      assert.strictEqual(state.interactionMode, 'none');
      assert.strictEqual(state.pendingInteractionMode, 'none');

      const patch = cameraTeardown.teardown({ kind: 'session-reset' }, state as never);

      assert.strictEqual(patch.interactionMode, 'all');
      assert.strictEqual(patch.pendingInteractionMode, null);
    });

    it('declares both fields in owns, so the patch cannot drift from them', () => {
      assert.ok(cameraTeardown.owns.includes('interactionMode'));
      assert.ok(cameraTeardown.owns.includes('pendingInteractionMode'));
    });
  });

  describe('session-reset teardown (#3364)', () => {
    it('clears a pending rotation recorded before any renderer registered', () => {
      // Distinctly non-default: the default is CAMERA_DEFAULTS.AZIMUTH/ELEVATION,
      // so a fixture equal to it could not distinguish "cleared" from "replayed".
      build(false);
      state.setCameraRotation({ azimuth: 199, elevation: 61 });
      assert.strictEqual(state.pendingCameraRotation?.azimuth, 199);

      const patch = cameraTeardown.teardown({ kind: 'session-reset' }, state as never);

      assert.strictEqual(
        patch.pendingCameraRotation,
        null,
        "a session reset must drop the outgoing model's pending rotation, or the next " +
          'viewport to register cameraCallbacks replays it onto the new model',
      );
    });

    it('declares pendingCameraRotation in owns, so the patch cannot drift from it', () => {
      assert.ok(cameraTeardown.owns.includes('pendingCameraRotation'));    });
  });

  describe('updateCameraRotationRealtime', () => {
    it('stays off the actuator — the per-frame path reports, it does not command', () => {
      // This is the callback the live navigation loop drives on every frame.
      // Routing it through the actuator would fight the very gesture that
      // produced it.
      state.setOnCameraRotationChange(() => {});
      state.updateCameraRotationRealtime({ azimuth: 200, elevation: 10 });

      assert.deepStrictEqual(calls, []);
    });
  });
});
