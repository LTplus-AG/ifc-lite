/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera state slice
 */

import type { StateCreator } from 'zustand';
import type { CameraRotation, CameraCallbacks, ProjectionMode } from '../types.js';
import { CAMERA_DEFAULTS } from '../constants.js';
import { defineSliceTeardown } from '../teardown.js';

/** The home orientation, in one place: the slice's initial value and the
 *  session-reset teardown must not be able to drift apart. */
const defaultCameraRotation = (): CameraRotation => ({
  azimuth: CAMERA_DEFAULTS.AZIMUTH,
  elevation: CAMERA_DEFAULTS.ELEVATION,
});

/** Likewise for the projection: `perspective` is the startup mode. */
const DEFAULT_PROJECTION_MODE: ProjectionMode = 'perspective';

export interface CameraSlice {
  // State
  cameraRotation: CameraRotation;
  cameraCallbacks: CameraCallbacks;
  projectionMode: ProjectionMode;
  onCameraRotationChange: ((rotation: CameraRotation) => void) | null;
  onScaleChange: ((scale: number) => void) | null;

  // Actions
  setCameraRotation: (rotation: CameraRotation) => void;
  setCameraCallbacks: (callbacks: CameraCallbacks) => void;
  /** A rotation accepted before any renderer was registered, replayed by
   *  {@link setCameraCallbacks}. `null` once applied. */
  pendingCameraRotation: CameraRotation | null;
  setProjectionMode: (mode: ProjectionMode) => void;
  toggleProjectionMode: () => void;
  setOnCameraRotationChange: (callback: ((rotation: CameraRotation) => void) | null) => void;
  /** Additional (multi-)listeners on the same live-navigation feed as
   *  {@link onCameraRotationChange}, whose single slot is owned by the
   *  ViewCube. Returns an unsubscribe function. */
  cameraRotationListeners: Set<(rotation: CameraRotation) => void>;
  subscribeCameraRotation: (listener: (rotation: CameraRotation) => void) => () => void;
  updateCameraRotationRealtime: (rotation: CameraRotation) => void;
  setOnScaleChange: (callback: ((scale: number) => void) | null) => void;
  updateScaleRealtime: (scale: number) => void;
}

export const createCameraSlice: StateCreator<CameraSlice, [], [], CameraSlice> = (set, get) => ({
  // Initial state
  cameraRotation: defaultCameraRotation(),
  pendingCameraRotation: null,
  cameraCallbacks: {},
  projectionMode: DEFAULT_PROJECTION_MODE,
  onCameraRotationChange: null,
  cameraRotationListeners: new Set(),
  onScaleChange: null,

  // Actions
  // Drive the renderer FIRST, then record — the same shape as
  // setProjectionMode below. Recording alone is what made the embed API's
  // SET_CAMERA inert: the store field was written, `CAMERA_CHANGED` echoed it
  // back to the host as confirmation, and the camera never moved (#2934).
  // This is the absolute-orientation path only; live navigation reports
  // through `updateCameraRotationRealtime`, which must NOT actuate.
  setCameraRotation: (cameraRotation) => {
    const actuator = get().cameraCallbacks.setCameraRotation;
    actuator?.(cameraRotation);
    // If no renderer was registered yet the command was ACKED and nothing moved.
    // An embed host can send SET_CAMERA before `Viewport`'s effect registers its
    // callbacks, and `setCameraCallbacks` used to only store them, so the pose
    // was recorded in state and never reached the camera: success reported for
    // something that did not happen. Remember it and replay on registration.
    set({ cameraRotation, pendingCameraRotation: actuator ? null : cameraRotation });
  },
  setCameraCallbacks: (cameraCallbacks) => {
    const pending = get().pendingCameraRotation;
    set({ cameraCallbacks, pendingCameraRotation: null });
    if (pending) cameraCallbacks.setCameraRotation?.(pending);
  },
  setProjectionMode: (projectionMode) => {
    get().cameraCallbacks.setProjectionMode?.(projectionMode);
    set({ projectionMode });
  },
  toggleProjectionMode: () => {
    const newMode = get().projectionMode === 'perspective' ? 'orthographic' : 'perspective';
    get().cameraCallbacks.setProjectionMode?.(newMode);
    set({ projectionMode: newMode });
  },
  setOnCameraRotationChange: (onCameraRotationChange) => set({ onCameraRotationChange }),

  // `onCameraRotationChange` is a single slot and the ViewCube owns it
  // (ViewportOverlays.tsx), so anything else that needs the live feed — the
  // embed's outbound CAMERA_CHANGED, which otherwise only ever saw
  // programmatic `setCameraRotation` (#2934) — needs its own channel. The Set
  // is created once and mutated in place: it is never handed to a React
  // selector, so add/remove must not (and does not) trigger a re-render.
  subscribeCameraRotation: (listener) => {
    const listeners = get().cameraRotationListeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  updateCameraRotationRealtime: (rotation) => {
    const callback = get().onCameraRotationChange;
    if (callback) {
      // Use direct callback - no React state update, no re-renders
      callback(rotation);
    }
    for (const listener of get().cameraRotationListeners) {
      listener(rotation);
    }
    // Don't update store state during real-time updates
  },

  setOnScaleChange: (onScaleChange) => set({ onScaleChange }),

  updateScaleRealtime: (scale) => {
    const callback = get().onScaleChange;
    if (callback) {
      // Use direct callback - no React state update, no re-renders
      callback(scale);
    }
    // Don't update store state during real-time updates
  },
});

/**
 * What a session reset clears on the camera slice.
 *
 * `resetViewerState`'s "Camera" block (`store/index.ts`): a new file gets the
 * home orientation and the default projection rather than inheriting the pose
 * the user left on the outgoing model.
 *
 * PURE, like every teardown — and that matches today's behaviour exactly:
 * `resetViewerState` writes both fields straight into `set()` without going
 * through `setCameraRotation` / `setProjectionMode`, so the renderer actuators
 * are NOT driven here. The reframe comes from the load path instead. Calling
 * an actuator from a teardown would be a behaviour change, not a tidy-up.
 *
 * `pendingCameraRotation` IS owned (#3364): it is a replay buffer keyed to
 * whatever renderer registers `setCameraCallbacks` NEXT, not to the model
 * that recorded it. Before this fix, a rotation set while no actuator was
 * registered (`setCameraRotation`, above) survived a session reset untouched,
 * so the next model's `Viewport` mounting and calling `setCameraCallbacks`
 * replayed the OUTGOING model's rotation onto the INCOMING one. A session
 * reset now discards the pending rotation below, closing that gap.
 *
 * `cameraCallbacks`, the two callback slots and `cameraRotationListeners`
 * are still absent from `owns`: they are renderer/host wiring that outlives
 * a file swap, and no teardown path touches them today.
 */
export const cameraTeardown = defineSliceTeardown(
  'cameraSlice',
  ['cameraRotation', 'pendingCameraRotation', 'projectionMode'],
  (scope) => {
    if (scope.kind !== 'session-reset') return {};
    return {
      cameraRotation: defaultCameraRotation(),
      pendingCameraRotation: null,
      projectionMode: DEFAULT_PROJECTION_MODE,
    };
  },
);
