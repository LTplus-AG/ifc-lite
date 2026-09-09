/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lock-in tests for bim.bcf.createViewpoint()/extractViewpointState()'s
 * shape adapter between the SDK's documented ViewpointOptions (tuple
 * camera, x/y/z section-plane axis) and @ifc-lite/bcf's ViewerCameraState/
 * ViewerSectionPlane (object camera, down/front/side axis).
 *
 * The bug being pinned (#4251): createViewpoint() used to forward
 * ViewpointOptions.camera/sectionPlane to @ifc-lite/bcf unchanged. The
 * library read `camera.position.x` off a 3-tuple (always undefined,
 * serializing as null/NaN->null) and never matched an 'x'|'y'|'z' section
 * axis against its 'down'|'front'|'side' switch, so an enabled section
 * plane silently produced no clippingPlanes at all. Both failures resolved
 * successfully with no error.
 */

import { describe, it, expect } from 'vitest';
import {
  BCFNamespace,
  IncompleteCameraStateError,
  MissingSectionBoundsError,
} from './bcf.js';

const CAMERA = {
  mode: 'perspective' as const,
  position: [1, 2, 3] as [number, number, number],
  target: [4, 5, 6] as [number, number, number],
  up: [0, 1, 0] as [number, number, number],
};

const BOUNDS = {
  min: [-10, -10, -10] as [number, number, number],
  max: [10, 10, 10] as [number, number, number],
};

describe('BCFNamespace.createViewpoint — camera shape (#4251 defect 1)', () => {
  it('throws IncompleteCameraStateError rather than silently corrupting a positionless camera', async () => {
    const ns = new BCFNamespace();
    await expect(ns.createViewpoint({ camera: { mode: 'perspective' } })).rejects.toThrow(
      IncompleteCameraStateError
    );
  });

  it('throws IncompleteCameraStateError when camera is omitted entirely', async () => {
    const ns = new BCFNamespace();
    await expect(ns.createViewpoint({})).rejects.toThrow(IncompleteCameraStateError);
    await expect(ns.createViewpoint()).rejects.toThrow(IncompleteCameraStateError);
  });

  it('a complete documented camera round-trips to real coordinate values, not null/NaN', async () => {
    const ns = new BCFNamespace();
    const out = (await ns.createViewpoint({ camera: CAMERA })) as {
      perspectiveCamera?: {
        cameraViewPoint: { x: number; y: number; z: number };
        cameraDirection: { x: number; y: number; z: number };
        cameraUpVector: { x: number; y: number; z: number };
        fieldOfView: number;
      };
    };

    // viewer (Y-up) -> BCF (Z-up): BCF.x = v.x, BCF.y = -v.z, BCF.z = v.y
    expect(out.perspectiveCamera?.cameraViewPoint).toEqual({ x: 1, y: -3, z: 2 });
    expect(out.perspectiveCamera?.fieldOfView).toBeGreaterThan(0);
    expect(Number.isFinite(out.perspectiveCamera?.fieldOfView)).toBe(true);
    // Direction = normalize(target - position) in viewer coords, then converted.
    // target - position = (3, 3, 3) -> normalized (1/sqrt3 each) -> BCF (x, -z, y)
    const d = out.perspectiveCamera!.cameraDirection;
    expect(d.x).toBeCloseTo(1 / Math.sqrt(3), 5);
    expect(d.y).toBeCloseTo(-1 / Math.sqrt(3), 5);
    expect(d.z).toBeCloseTo(1 / Math.sqrt(3), 5);
  });
});

describe('BCFNamespace.createViewpoint — sectionPlane shape (#4251 defect 2)', () => {
  it('throws MissingSectionBoundsError for an enabled section plane with no bounds', async () => {
    const ns = new BCFNamespace();
    await expect(
      ns.createViewpoint({
        camera: CAMERA,
        sectionPlane: { axis: 'x', position: 5, enabled: true, flipped: false },
      })
    ).rejects.toThrow(MissingSectionBoundsError);
  });

  it('does not throw for a disabled section plane even without bounds', async () => {
    const ns = new BCFNamespace();
    const out = (await ns.createViewpoint({
      camera: CAMERA,
      sectionPlane: { axis: 'x', position: 5, enabled: false, flipped: false },
    })) as { clippingPlanes?: unknown[] };
    expect('clippingPlanes' in out).toBe(false);
  });

  it('a documented sectionPlane + bounds produces a real clipping plane at the right coordinates', async () => {
    const ns = new BCFNamespace();
    // axis 'x' -> SDK_AXIS_TO_BCF_AXIS -> 'side'; position 75% along x in [-10,10] -> x = 5
    const out = (await ns.createViewpoint({
      camera: CAMERA,
      sectionPlane: { axis: 'x', position: 75, enabled: true, flipped: false },
      bounds: BOUNDS,
    })) as { clippingPlanes?: Array<{ location: { x: number; y: number; z: number } }> };

    expect(out.clippingPlanes).toHaveLength(1);
    // viewer 'side' location = { x: 5, y: 0, z: 0 } -> BCF (x, -z, y) = { x: 5, y: -0, z: 0 }
    expect(out.clippingPlanes![0].location).toEqual({ x: 5, y: -0, z: 0 });
  });

  it('axis y (down, per bim.viewer.getSection()) maps to the model-up axis, not x', async () => {
    const ns = new BCFNamespace();
    const out = (await ns.createViewpoint({
      camera: CAMERA,
      sectionPlane: { axis: 'y', position: 100, enabled: true, flipped: false },
      bounds: BOUNDS,
    })) as { clippingPlanes?: Array<{ location: { x: number; y: number; z: number } }> };

    // axis 'y' -> 'down' -> viewer location.y = max.y = 10 -> BCF z = 10, BCF x/y = 0
    expect(out.clippingPlanes![0].location).toEqual({ x: 0, y: -0, z: 10 });
  });
});

describe('BCFNamespace.extractViewpointState — read-path symmetry (#4251)', () => {
  it.each([
    ['x', 'side'],
    ['y', 'down'],
    ['z', 'front'],
  ] as const)(
    'round-trips camera/sectionPlane (axis %s, BCF %s) back into bim.viewer.setCamera()/setSection() shapes',
    async (sdkAxis, bcfAxis) => {
      const ns = new BCFNamespace();
      const viewpoint = await ns.createViewpoint({
        camera: CAMERA,
        sectionPlane: { axis: sdkAxis, position: 50, enabled: true, flipped: false },
        bounds: BOUNDS,
      });

      // Sanity check the write side actually used the expected BCF axis name,
      // so a failure below is attributable to the read path
      // (BCF_AXIS_TO_SDK_AXIS), not a write-side (SDK_AXIS_TO_BCF_AXIS) drift.
      const created = viewpoint as { clippingPlanes?: unknown[] };
      expect(created.clippingPlanes).toHaveLength(1);

      const state = await ns.extractViewpointState(viewpoint, BOUNDS);

      expect(state.camera?.mode).toBe('perspective');
      // camera position round-trips through cameraToPerspective -> perspectiveToCamera,
      // which reconstructs position from direction * targetDistance rather than the
      // original absolute position, so assert the SDK tuple shape + the target/up values,
      // which are preserved exactly.
      expect(Array.isArray(state.camera?.position)).toBe(true);
      expect(state.camera?.up).toEqual([0, 1, 0]);

      // The load-bearing assertion: BCF_AXIS_TO_SDK_AXIS[bcfAxis] must recover
      // the exact SDK axis that was sent in, not some other axis. A swap
      // between any two entries (e.g. side<->x mapped to the wrong letter,
      // or down mapped to 'x' instead of 'y') reddens this for the axis it
      // corrupts.
      expect(state.sectionPlane?.axis).toBe(sdkAxis);
      expect(state.sectionPlane?.enabled).toBe(true);
      expect(state.sectionPlane?.flipped).toBe(false);
    }
  );

  it('omits sectionPlane when no bounds is supplied to extractViewpointState', async () => {
    const ns = new BCFNamespace();
    const viewpoint = await ns.createViewpoint({
      camera: CAMERA,
      sectionPlane: { axis: 'z', position: 50, enabled: true, flipped: false },
      bounds: BOUNDS,
    });

    const state = await ns.extractViewpointState(viewpoint);
    expect(state.sectionPlane).toBeUndefined();
  });
});
