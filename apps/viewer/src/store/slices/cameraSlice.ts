/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera state slice
 */

import type { StateCreator } from 'zustand';
import type { CameraRotation, CameraCallbacks, ProjectionMode } from '../types.js';
import { CAMERA_DEFAULTS } from '../constants.js';

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
  updateCameraRotationRealtime: (rotation: CameraRotation) => void;
  setOnScaleChange: (callback: ((scale: number) => void) | null) => void;
  updateScaleRealtime: (scale: number) => void;
}

export const createCameraSlice: StateCreator<CameraSlice, [], [], CameraSlice> = (set, get) => ({
  // Initial state
  cameraRotation: {
    azimuth: CAMERA_DEFAULTS.AZIMUTH,
    elevation: CAMERA_DEFAULTS.ELEVATION,
  },
  pendingCameraRotation: null,
  cameraCallbacks: {},
  projectionMode: 'perspective',
  onCameraRotationChange: null,
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

  updateCameraRotationRealtime: (rotation) => {
    const callback = get().onCameraRotationChange;
    if (callback) {
      // Use direct callback - no React state update, no re-renders
      callback(rotation);
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
