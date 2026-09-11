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
      // BCF stores view direction, not the target point, so the target is
      // reconstructed too — but the recovered position->target direction
      // must be the original (4,5,6)-(1,2,3) = (3,3,3) normalised.
      const pos = state.camera!.position as [number, number, number];
      const tgt = state.camera!.target as [number, number, number];
      const dir = [tgt[0] - pos[0], tgt[1] - pos[1], tgt[2] - pos[2]];
      const len = Math.hypot(...dir);
      for (const c of dir) expect(c / len).toBeCloseTo(1 / Math.sqrt(3), 6);

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

// ============================================================================
// sectionPlaneToClippingPlane / clippingPlaneToSectionPlane (#4265)
//
// Both wrappers forward straight to @ifc-lite/bcf's own object-shaped
// ViewerSectionPlane/BCFClippingPlane — unlike
// createViewpoint()/extractViewpointState() above, they do not adapt the
// SDK's tuple/x-y-z plane shapes, matching #4265's own repro which called
// them with the library's shapes directly. `bounds` is the exception: the
// SDK's tuple AABB is accepted as well as the library's object shape.
// ============================================================================

const LIBRARY_BOUNDS = {
  min: { x: -10, y: -10, z: 0 },
  max: { x: 10, y: 10, z: 10 },
};

describe('BCFNamespace.sectionPlaneToClippingPlane — bounds argument (#4265)', () => {
  it('forwards bounds instead of dropping it, and returns real coordinates', async () => {
    const ns = new BCFNamespace();
    const sectionPlane = { axis: 'front' as const, position: 50, enabled: true, flipped: false };

    const out = (await ns.sectionPlaneToClippingPlane(sectionPlane, LIBRARY_BOUNDS)) as {
      location: { x: number; y: number; z: number };
      direction: { x: number; y: number; z: number };
    };

    // viewer 'front' (Z axis) at 50% of [0,10] -> z=5, x/y at box center (0,0)
    // -> BCF (x, -z, y) = { x: 0, y: -5, z: 0 }
    expect(out.location).toEqual({ x: 0, y: -5, z: 0 });
    expect(out.direction).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('without bounds, a documented call throws inside @ifc-lite/bcf reading bounds.min', async () => {
    const ns = new BCFNamespace();
    const sectionPlane = { axis: 'front' as const, position: 50, enabled: true, flipped: false };

    // @ts-expect-error — exercising the pre-fix call shape (bounds omitted)
    await expect(ns.sectionPlaneToClippingPlane(sectionPlane)).rejects.toThrow();
  });

  it('accepts the SDK tuple AABB shape for bounds (not NaN locations)', async () => {
    const ns = new BCFNamespace();
    const sectionPlane = { axis: 'front' as const, position: 50, enabled: true, flipped: false };
    const tupleBounds = { min: [-10, -10, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] };

    const out = (await ns.sectionPlaneToClippingPlane(sectionPlane, tupleBounds)) as {
      location: { x: number; y: number; z: number };
    };
    expect(out.location).toEqual({ x: 0, y: -5, z: 0 });
  });
});

describe('BCFNamespace.clippingPlaneToSectionPlane — bounds argument (#4265)', () => {
  it('forwards bounds instead of dropping it, and returns real coordinates', async () => {
    const ns = new BCFNamespace();
    const clippingPlane = { location: { x: 0, y: 0, z: 5 }, direction: { x: 0, y: 0, z: -1 } };

    const out = (await ns.clippingPlaneToSectionPlane(clippingPlane, LIBRARY_BOUNDS)) as {
      axis: 'down' | 'front' | 'side';
      position: number;
      enabled: boolean;
      flipped: boolean;
    };

    // BCF (0,0,5) -> viewer (0,5,0); direction (0,0,-1) -> viewer (0,-1,0)
    // -> Y axis dominant ('down'); position = (5 - (-10)) / 20 * 100 = 75
    expect(out).toEqual({ axis: 'down', position: 75, enabled: true, flipped: false });
  });

  it('without bounds, a documented call throws inside @ifc-lite/bcf reading bounds.max', async () => {
    const ns = new BCFNamespace();
    const clippingPlane = { location: { x: 0, y: 0, z: 5 }, direction: { x: 0, y: 0, z: -1 } };

    // @ts-expect-error — exercising the pre-fix call shape (bounds omitted)
    await expect(ns.clippingPlaneToSectionPlane(clippingPlane)).rejects.toThrow();
  });

  it('accepts the SDK tuple AABB shape for bounds (not the 50% fallback)', async () => {
    const ns = new BCFNamespace();
    const clippingPlane = { location: { x: 0, y: 0, z: 5 }, direction: { x: 0, y: 0, z: -1 } };
    const tupleBounds = { min: [-10, -10, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] };

    const out = (await ns.clippingPlaneToSectionPlane(clippingPlane, tupleBounds)) as { axis: string; position: number };
    expect(out).toMatchObject({ axis: 'down', position: 75 });
  });
});

describe('sectionPlaneToClippingPlane <-> clippingPlaneToSectionPlane round-trip (#4265)', () => {
  it('round-trips a section plane through both converters back to itself', async () => {
    const ns = new BCFNamespace();
    const original = { axis: 'side' as const, position: 30, enabled: true, flipped: false };

    const clippingPlane = await ns.sectionPlaneToClippingPlane(original, LIBRARY_BOUNDS);
    const roundTripped = await ns.clippingPlaneToSectionPlane(clippingPlane, LIBRARY_BOUNDS);

    expect(roundTripped).toEqual(original);
  });
});

// ============================================================================
// cameraToOrthogonal — viewToWorldScale argument (#4294)
//
// Unlike sectionPlaneToClippingPlane/clippingPlaneToSectionPlane above
// (#4265), the library function does not dereference the dropped argument,
// so the pre-fix wrapper did not throw — it returned a well-formed-looking
// BCFOrthogonalCamera with viewToWorldScale silently undefined. That value
// is a required xs:double when the camera is written (writer-camera.ts's
// xsdDouble), so the defect only surfaced later, at write time, far from
// the call that dropped the argument.
// ============================================================================

const ORTHO_CAMERA = {
  position: { x: 1, y: 2, z: 3 },
  target: { x: 4, y: 5, z: 6 },
  up: { x: 0, y: 1, z: 0 },
  fov: Math.PI / 4,
};

describe('BCFNamespace.cameraToOrthogonal — viewToWorldScale argument (#4294)', () => {
  it('forwards viewToWorldScale to a real number, not silently to undefined', async () => {
    const ns = new BCFNamespace();
    const out = (await ns.cameraToOrthogonal(ORTHO_CAMERA, 7.25)) as { viewToWorldScale: number };
    expect(out.viewToWorldScale).toBe(7.25);
  });

  it('the pre-fix call shape (argument omitted) leaves viewToWorldScale undefined without throwing', async () => {
    const ns = new BCFNamespace();
    // @ts-expect-error — exercising the pre-fix call shape (viewToWorldScale omitted)
    const out = (await ns.cameraToOrthogonal(ORTHO_CAMERA)) as { viewToWorldScale: number };
    // No rejection: this is the silent-corruption shape #4294 reports, distinct
    // from #4265's siblings which throw immediately when the argument is missing.
    expect(out.viewToWorldScale).toBeUndefined();
  });

  it('an orthogonal camera with viewToWorldScale undefined fails at write time, not at conversion time', async () => {
    const ns = new BCFNamespace();
    const project = await ns.createProject({ name: 'p' });
    const topic = await ns.createTopic({ title: 't', author: 'a' });
    await ns.addTopic(project, topic);
    const viewpoint = (await ns.createViewpoint({
      camera: { mode: 'perspective', position: [0, 0, 0], target: [0, 0, 1], up: [0, 1, 0] },
    })) as Record<string, unknown>;
    delete viewpoint.perspectiveCamera;
    // @ts-expect-error — exercising the pre-fix call shape (viewToWorldScale omitted)
    viewpoint.orthogonalCamera = await ns.cameraToOrthogonal(ORTHO_CAMERA);
    await ns.addViewpoint(topic, viewpoint);

    await expect(ns.write(project)).rejects.toThrow(/ViewToWorldScale/);
  });
});
