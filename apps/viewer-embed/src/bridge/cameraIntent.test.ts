/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The #3390 cases the bridge-level tests cannot reach: when the queue releases,
 * what happens when a load does NOT deliver a model, and how long the framing
 * bit the embed reads stays true.
 *
 * Driven against the real `createCameraSlice`, so "applied" means the pose
 * actually reached the renderer actuator rather than a recorded call.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createCameraSlice } from '@/store/slices/cameraSlice.js';
import type { CameraRotation } from '@/store/types.js';
import {
  aroundDestructiveLoad,
  hostPoseAppliedToCurrentModel,
  offerHostPose,
  resetCameraIntent,
} from './cameraIntent.js';

/**
 * The real camera slice with a recording renderer actuator.
 *
 * `registerRenderer` is deferred with `{ renderer: false }` for the tests that
 * need the store's OTHER branch: with no actuator registered
 * `setCameraRotation` arms `pendingCameraRotation` instead of driving
 * anything, which is the field this module lifts.
 */
function makeCameraState({ renderer = true }: { renderer?: boolean } = {}) {
  const driven: CameraRotation[] = [];
  let state: any;
  const set = (partial: any) => {
    const updates = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...updates };
  };
  state = createCameraSlice(set, () => state, undefined as never);
  const registerRenderer = () => {
    state.setCameraCallbacks({
      setCameraRotation: (rotation: CameraRotation) => { driven.push(rotation); },
    });
  };
  if (renderer) registerRenderer();
  return { driven, getState: () => state, registerRenderer };
}

beforeEach(() => {
  resetCameraIntent();
});

describe('offerHostPose', () => {
  it('applies straight through when no destructive load is running', () => {
    const store = makeCameraState();

    offerHostPose({ azimuth: 12, elevation: 3 }, store.getState);

    expect(store.driven).toEqual([{ azimuth: 12, elevation: 3 }]);
    // Not a load, so the framing bit stays false and the first model still
    // gets its default framing.
    expect(hostPoseAppliedToCurrentModel()).toBe(false);
  });

  it('supersedes a pose queued against a load that is already over', async () => {
    const store = makeCameraState();

    // A load runs with a pose queued against it; the load releases the pose on
    // the way out, so the queue is empty by the time the host speaks again.
    const load = aroundDestructiveLoad(store.getState, () => Promise.resolve());
    offerHostPose({ azimuth: 99, elevation: 40 }, store.getState);
    await load;

    // The host then commands a new pose with nothing in flight. That is the
    // live scene talking, and it is the pose the camera must end at.
    offerHostPose({ azimuth: 12, elevation: 3 }, store.getState);

    expect(store.driven).toEqual([
      { azimuth: 99, elevation: 40 },
      { azimuth: 12, elevation: 3 },
    ]);
  });
});

describe('aroundDestructiveLoad', () => {
  it('applies a queued pose when the load fails, since nothing was reset', async () => {
    // Before the queue existed, a pose set during a failing fetch simply
    // survived: `resetViewerState()` never ran. Holding it for an incoming
    // model that never arrives would be a new way to lose the same command —
    // and worse, it would surface on some later load the host never linked it
    // to. `loadFile` is never reached on this path, so no post-load effect
    // runs to drain the queue either.
    const store = makeCameraState();

    const failing = aroundDestructiveLoad(store.getState, () =>
      Promise.reject(new Error('Failed to fetch model: Not Found')));
    offerHostPose({ azimuth: 137, elevation: 61 }, store.getState);
    await expect(failing).rejects.toThrow('Failed to fetch model');

    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);
    // No model arrived, so there is nothing for the first-load framing to
    // treat as host-posed.
    expect(hostPoseAppliedToCurrentModel()).toBe(false);
  });

  it('holds the pose back until the load resolves, then applies it', async () => {
    // The whole point: applying it while the fetch is outstanding aims the
    // scene the session reset is about to replace.
    const store = makeCameraState();

    let releaseFetch!: () => void;
    const fetched = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const load = aroundDestructiveLoad(store.getState, () => fetched);
    offerHostPose({ azimuth: 137, elevation: 61 }, store.getState);

    expect(store.driven).toEqual([]);

    releaseFetch();
    await load;

    // Deferred, not lost.
    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);
    expect(hostPoseAppliedToCurrentModel()).toBe(true);
  });

  it('keeps the pose held until the LAST of two overlapping loads finishes', async () => {
    // A host can post a second LOAD_MODEL before the first resolves. Releasing
    // on the first completion would apply the pose with the second load's
    // session reset still ahead of it.
    const store = makeCameraState();

    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const first = aroundDestructiveLoad(store.getState, () => Promise.resolve());
    const later = aroundDestructiveLoad(store.getState, () => second);
    offerHostPose({ azimuth: 137, elevation: 61 }, store.getState);

    await first;
    expect(store.driven).toEqual([]);

    releaseSecond();
    await later;
    expect(store.driven).toEqual([{ azimuth: 137, elevation: 61 }]);
  });

  it('does not re-lift a superseded store pose when loads overlap (#3390)', async () => {
    // The lift at load entry reads `pendingCameraRotation`, and the reset that
    // clears that field runs inside `loadFile`, well after the load starts. So
    // a second LOAD_MODEL posted before the first one's reset sees the FIRST
    // pose still armed in the store — and re-lifting it would overwrite the
    // newer pose the host queued in between, ending the camera on a command
    // the host had already replaced. `offerHostPose`'s no-load path clears the
    // queue before it arms the store, so a queued pose at load entry is always
    // the newer of the two.
    const store = makeCameraState({ renderer: false });

    // No renderer registered yet, so this arms the store's replay buffer.
    offerHostPose({ azimuth: 1, elevation: 1 }, store.getState);
    expect(store.getState().pendingCameraRotation).toEqual({ azimuth: 1, elevation: 1 });

    let releaseFirst!: () => void;
    const firstFetch = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = aroundDestructiveLoad(store.getState, () => firstFetch);

    // The host changes its mind while the first fetch is still outstanding.
    offerHostPose({ azimuth: 2, elevation: 2 }, store.getState);

    // ...and starts a second destructive load before the first has reset.
    let releaseSecond!: () => void;
    const secondFetch = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const second = aroundDestructiveLoad(store.getState, () => secondFetch);
    expect(store.getState().pendingCameraRotation).toEqual({ azimuth: 1, elevation: 1 });

    releaseFirst();
    await first;
    releaseSecond();
    await second;

    // The incoming model's renderer registers and replays what is armed.
    store.registerRenderer();

    expect(store.driven).toEqual([{ azimuth: 2, elevation: 2 }]);
    expect(hostPoseAppliedToCurrentModel()).toBe(true);
  });

  it('clears the framing bit when the next load carries no host pose', async () => {
    // `hostPoseAppliedToCurrentModel` answers for the model on screen NOW. A
    // stale true would make the next model's first-load framing skip `home()`
    // for a pose nobody asked about.
    const store = makeCameraState();

    const posed = aroundDestructiveLoad(store.getState, () => Promise.resolve());
    offerHostPose({ azimuth: 137, elevation: 61 }, store.getState);
    await posed;
    expect(hostPoseAppliedToCurrentModel()).toBe(true);

    await aroundDestructiveLoad(store.getState, () => Promise.resolve());

    expect(hostPoseAppliedToCurrentModel()).toBe(false);
  });
});
