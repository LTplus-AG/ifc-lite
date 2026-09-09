/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.bcf.createViewpoint()` forwarded `ViewpointOptions` straight through
 * to `@ifc-lite/bcf`'s `createViewpoint`, which expects an entirely
 * different shape:
 *
 * - `ViewpointOptions.camera` is documented as coming from
 *   `bim.viewer.getCamera()` — `{mode, position:[x,y,z], target:[x,y,z],
 *   up:[x,y,z]}` (tuples). The library's `ViewerCameraState` expects
 *   `{position:{x,y,z}, target:{x,y,z}, up:{x,y,z}, fov, ...}` (objects). The
 *   mismatch reads as `camera.position.x` on an array, i.e. `undefined`, so
 *   every produced viewpoint had a `perspectiveCamera.cameraViewPoint` of
 *   `{y: null}` and a `fieldOfView` of `null` — silently, with no error.
 * - `ViewpointOptions.sectionPlane` was forwarded to a library branch gated
 *   on `sectionPlane?.enabled && bounds`, and the SDK never supplies
 *   `bounds` (no such field exists on `ViewpointOptions`). An `enabled:
 *   true` section plane produced a viewpoint with no `clippingPlanes` key
 *   at all, again silently.
 */

import { describe, expect, it } from 'vitest';
import { BCFNamespace } from './bcf.js';

interface PerspectiveCamera {
  cameraViewPoint: { x: number; y: number; z: number };
  cameraDirection: { x: number; y: number; z: number };
  cameraUpVector: { x: number; y: number; z: number };
  fieldOfView: number;
}

interface Viewpoint {
  guid: string;
  perspectiveCamera?: PerspectiveCamera;
  clippingPlanes?: unknown[];
}

describe('BCFNamespace.createViewpoint — camera shape adapter', () => {
  it('translates the SDK tuple camera into a real, non-null perspectiveCamera', async () => {
    const bcf = new BCFNamespace();
    const viewpoint = (await bcf.createViewpoint({
      camera: {
        mode: 'perspective',
        position: [1, 2, 3],
        target: [4, 5, 6],
        up: [0, 1, 0],
      },
    })) as Viewpoint;

    expect(viewpoint.perspectiveCamera).toBeDefined();
    const camera = viewpoint.perspectiveCamera!;
    // The library converts viewer Y-up (1,2,3) into BCF Z-up: {x, -z, y}.
    // A corrupted camera (reading `.position.x` off a `[1,2,3]` tuple)
    // yields `undefined`/`NaN`, not a real number — assert real finite
    // numbers matching the known conversion, not merely "not null".
    expect(camera.cameraViewPoint.x).toBe(1);
    expect(camera.cameraViewPoint.y).toBe(-3);
    expect(camera.cameraViewPoint.z).toBe(2);
    expect(Number.isFinite(camera.cameraViewPoint.x)).toBe(true);
    expect(Number.isFinite(camera.cameraViewPoint.y)).toBe(true);
    expect(Number.isFinite(camera.cameraViewPoint.z)).toBe(true);
    expect(Number.isFinite(camera.fieldOfView)).toBe(true);
  });
});

describe('BCFNamespace.createViewpoint — sectionPlane fails loud without bounds', () => {
  it('rejects an enabled sectionPlane instead of silently dropping it', async () => {
    const bcf = new BCFNamespace();
    await expect(
      bcf.createViewpoint({
        camera: { mode: 'perspective', position: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0] },
        sectionPlane: { axis: 'x', position: 5, enabled: true, flipped: false },
      })
    ).rejects.toThrow(/sectionPlane\.enabled is true, but this SDK has no model bounds/);
  });

  it('does not throw for a disabled sectionPlane', async () => {
    const bcf = new BCFNamespace();
    const viewpoint = (await bcf.createViewpoint({
      camera: { mode: 'perspective', position: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0] },
      sectionPlane: { axis: 'x', position: 5, enabled: false, flipped: false },
    })) as Viewpoint;
    expect(viewpoint.clippingPlanes).toBeUndefined();
  });
});
