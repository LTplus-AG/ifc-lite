/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `DriverCamera` adapter for the opt-in 3Dconnexion driver path (#9131):
 * the only place the driver module meets the viewer's renderer. Type-only
 * import, so building the adapter loads nothing from the 3Dconnexion SDK.
 */

import type { DriverCamera } from '@/lib/spacemouse-driver/types';
import type { V3 } from '@/lib/spacemouse-driver/math';

type XYZ = { x: number; y: number; z: number };

/** The slice of `@ifc-lite/renderer`'s Camera the adapter uses. */
export interface DriverCameraHost {
  getPosition(): XYZ;
  getTarget(): XYZ;
  getUp(): XYZ;
  setPosition(x: number, y: number, z: number): void;
  setTarget(x: number, y: number, z: number): void;
  setUp(x: number, y: number, z: number): void;
  getFOV(): number;
  setFOV(rad: number): void;
  getAspect(): number;
  stopInertia(): void;
}

/** The slice of `@ifc-lite/renderer`'s Renderer the adapter uses; a `Renderer` satisfies it. */
export interface DriverRendererHost {
  getCamera(): DriverCameraHost;
  getCanvas(): HTMLElement;
  getScene(): { getBounds(): { min: XYZ; max: XYZ } | null };
  requestRender(): void;
}

const v = (p: XYZ): V3 => [p.x, p.y, p.z];

/** Above this |cos| between the view direction and world up, the driver's own up vector is kept. */
const STRAIGHT_UP_OR_DOWN = 0.999;

export function createDriverCamera(renderer: DriverRendererHost): DriverCamera {
  const cam = () => renderer.getCamera();
  return {
    canvas: renderer.getCanvas(),
    getPose: () => {
      const c = cam();
      return { pos: v(c.getPosition()), target: v(c.getTarget()), up: v(c.getUp()) };
    },
    setPose: (pos, target, up) => {
      // Keep the horizon level, as mouse orbit does; only looking straight up
      // or down uses the driver's up vector.
      const fy = target[1] - pos[1];
      const flen = Math.hypot(target[0] - pos[0], fy, target[2] - pos[2]) || 1;
      const u: V3 = Math.abs(fy / flen) > STRAIGHT_UP_OR_DOWN ? up : [0, 1, 0];
      const c = cam();
      c.stopInertia();
      c.setPosition(pos[0], pos[1], pos[2]);
      c.setTarget(target[0], target[1], target[2]);
      c.setUp(u[0], u[1], u[2]);
    },
    getFov: () => cam().getFOV(),
    setFov: (rad) => cam().setFOV(rad),
    getAspect: () => cam().getAspect(),
    getBounds: () => {
      const b = renderer.getScene().getBounds();
      return b ? { min: v(b.min), max: v(b.max) } : null;
    },
    requestRender: () => renderer.requestRender(),
  };
}
