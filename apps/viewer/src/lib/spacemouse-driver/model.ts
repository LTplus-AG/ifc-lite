/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { add, cross, len, mul, norm, matrixToPose, poseToMatrix, sub, type V3 } from './math.js';
import type { DriverCamera } from './types.js';

export interface ModelHooks {
  /** The device's "Fit" key was pressed. */
  onFit?: () => void;
  /** Pointer position over the view in normalised device coordinates, x right and y up, each in [-1, 1]. */
  pointer: () => [number, number];
}

/** V3DK_FIT in the 3Dconnexion key-code table. */
export const KEY_FIT = 0x1f;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * The navigation model: the object whose methods the 3Dconnexion navigation library calls. Method names and the value
 * formats are fixed by the 3DconnexionJS API:
 *   - matrices: 16 numbers, column-major, camera -> world
 *   - frustum:  [left, right, bottom, top, near, far] on the near plane, as for glFrustum
 *   - extents:  [minX, minY, minZ, maxX, maxY, maxZ]
 *   - points:   [x, y, z]
 * The driver computes the motion; it reads the camera through the getters and writes the result with `setViewMatrix`.
 */
export function createNavigationModel(cam: DriverCamera, hooks: ModelHooks) {
  const state = { pivot: null as V3 | null, moving: false };

  const bounds = () => cam.getBounds();
  const diag = () => {
    const b = bounds();
    return b ? Math.max(len(sub(b.max, b.min)), 1) : 100;
  };
  const near = () => Math.max(diag() * 1e-3, 0.01);
  const far = () => diag() * 10;

  return {
    state,

    // ---- reads: the driver asks for these ----
    // The renderer frame already is the library's: x right, y up, z towards the viewer.
    getCoordinateSystem: () => [...IDENTITY],
    getFrontView: () => [...IDENTITY],
    getConstructionPlane: () => null,
    getViewRotatable: () => true,
    getPerspective: () => true,
    getViewExtents: () => [-1, -1, -1, 1, 1, 1], // orthographic cameras only; the viewer is perspective
    getFov: () => cam.getFov(),
    getViewFrustum: () => {
      const n = near();
      const top = n * Math.tan(cam.getFov() / 2);
      const right = top * cam.getAspect();
      return [-right, right, -top, top, n, far()];
    },
    getViewMatrix: () => {
      const p = cam.getPose();
      return poseToMatrix(p.pos, p.target, p.up);
    },
    getViewTarget: () => cam.getPose().target,
    getModelExtents: (): number[] => {
      const b = bounds();
      return b ? [...b.min, ...b.max] : [-1, -1, -1, 1, 1, 1];
    },
    getFloorPlane: () => null,
    getUnitsToMeters: () => 1,
    getPivotPosition: () => state.pivot ?? cam.getPose().target,
    // No hit-testing: the library falls back to the model extents and the pivot.
    getLookAt: () => null,
    getSelectionEmpty: () => true,
    getSelectionExtents: () => null,
    getSelectionAffine: () => null,
    /** The pointer's world position on the near plane (the driver uses it for zoom-to-cursor). */
    getPointerPosition: (): number[] => {
      const p = cam.getPose();
      const f = norm(sub(p.target, p.pos));
      const r = norm(cross(f, p.up));
      const u = cross(r, f);
      const n = near();
      const top = n * Math.tan(cam.getFov() / 2);
      const [px, py] = hooks.pointer();
      return add(add(add(p.pos, mul(f, n)), mul(r, px * top * cam.getAspect())), mul(u, py * top));
    },

    // ---- writes: the driver sets these ----
    setViewMatrix: (m: number[]) => {
      if (!m || m.length < 16 || !m.every(Number.isFinite)) return;
      const p = cam.getPose();
      const next = matrixToPose(m, p.target, Math.max(len(sub(p.target, p.pos)), 1e-3));
      cam.setPose(next.pos, next.target, next.up);
      cam.requestRender();
    },
    setTarget: (t: number[]) => {
      if (!t || t.length < 3) return;
      const p = cam.getPose();
      cam.setPose(p.pos, [t[0], t[1], t[2]], p.up);
      cam.requestRender();
    },
    setFov: (rad: number) => {
      if (Number.isFinite(rad)) {
        cam.setFov(rad);
        cam.requestRender();
      }
    },
    setViewExtents: () => {},
    setTransaction: (t: number) => {
      if (t === 0) cam.requestRender(); // end of a batch of writes
    },
    setPivotPosition: (p: number[]) => {
      state.pivot = p && p.length >= 3 ? [p[0], p[1], p[2]] : null;
    },
    setPivotVisible: () => {},
    setLookFrom: () => {},
    setLookDirection: () => {},
    setLookAperture: () => {},
    setSelectionOnly: () => {},
    setSelectionAffine: () => {},
    setSettingsChanged: () => {},
    setActiveCommand: () => {},
    setKeyPress: (key: number) => {
      if (key === KEY_FIT) hooks.onFit?.();
    },
    setKeyRelease: () => {},
    onStartMotion: () => {
      state.moving = true;
    },
    onStopMotion: () => {
      state.moving = false;
      cam.requestRender();
    },
  };
}
