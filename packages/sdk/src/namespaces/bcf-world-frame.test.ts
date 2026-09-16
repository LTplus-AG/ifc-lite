/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.bcf.createViewpoint({ camera: bim.viewer.getCamera() })` writes a
 * world-coordinate viewpoint, and `extractViewpointState()` hands back a
 * camera for `setCamera()` in the viewer's frame (#4879).
 *
 * A viewer draws a georeferenced model shifted towards the origin, so
 * `getCamera()` is in that render frame. Before this, the SDK wrote it into
 * the BCF file raw, which puts the camera hundreds of kilometres from the
 * building in every other BCF tool, and read other tools' world cameras back
 * raw, which does the same in the viewer.
 */

import { describe, it, expect } from 'vitest';
import { BCFNamespace } from './bcf.js';
import { createBimContext } from '../context.js';
import { RemoteBackend } from '../transport/remote-backend.js';
import type { BimBackend, Transport, ViewerBackendMethods } from '../types.js';

/**
 * Render frame -> world for a model with the wasm RTC offset
 * (41266.679, 308208.972, 125.95) (IFC Z-up) AND a CoordinateHandler origin
 * shift (1800, -35, -2600) (Y-up), i.e. what the viewer adapter derives from
 * such a `CoordinateInfo`: x + 1800, y + 2600, z - 35.
 */
const OFFSET: [number, number, number] = [43066.679, 310808.972, 90.95];

/** A render-frame camera, as `bim.viewer.getCamera()` returns it (Y-up). */
const CAMERA = {
  mode: 'perspective' as const,
  position: [12, 8, -4] as [number, number, number],
  target: [2, 1, 3] as [number, number, number],
  up: [0, 1, 0] as [number, number, number],
};
/** Render-frame model bounds (Y-up) around the camera target. */
const BOUNDS = {
  min: [-20, 0, -20] as [number, number, number],
  max: [20, 10, 20] as [number, number, number],
};
const SECTION = { axis: 'y' as const, position: 40, enabled: true, flipped: false };

type Point = { x: number; y: number; z: number };
type Viewpoint = {
  perspectiveCamera?: { cameraViewPoint: Point; cameraDirection: Point };
  clippingPlanes?: Array<{ location: Point; direction: Point }>;
};

function viewerWithOffset(offset: [number, number, number]): Pick<BimBackend, 'viewer'> {
  const viewer: ViewerBackendMethods = {
    colorize: () => undefined,
    colorizeAll: () => undefined,
    resetColors: () => undefined,
    flyTo: () => undefined,
    setSection: () => undefined,
    getSection: () => SECTION,
    setCamera: () => undefined,
    getCamera: () => CAMERA,
    getRenderFrameOffset: () => offset,
  };
  return { viewer };
}

function expectClose(actual: Point | undefined, expected: Point): void {
  expect(actual).toBeDefined();
  expect(actual!.x).toBeCloseTo(expected.x, 6);
  expect(actual!.y).toBeCloseTo(expected.y, 6);
  expect(actual!.z).toBeCloseTo(expected.z, 6);
}

describe('bim.bcf viewpoints are world coordinates (#4879)', () => {
  it('createViewpoint adds the render-frame offset to the camera and the clipping plane', async () => {
    // Same inputs with no viewer: the render-frame reading of this viewpoint.
    const local = (await new BCFNamespace().createViewpoint({ camera: CAMERA, sectionPlane: SECTION, bounds: BOUNDS })) as Viewpoint;
    const world = (await new BCFNamespace(viewerWithOffset(OFFSET)).createViewpoint({
      camera: CAMERA, sectionPlane: SECTION, bounds: BOUNDS,
    })) as Viewpoint;

    const [ox, oy, oz] = OFFSET;
    const eye = local.perspectiveCamera!.cameraViewPoint;
    // Y-up (12, 8, -4) is IFC (12, 4, 8); world is that plus the offset.
    expect(eye).toEqual({ x: 12, y: 4, z: 8 });
    expectClose(world.perspectiveCamera?.cameraViewPoint, { x: 12 + ox, y: 4 + oy, z: 8 + oz });
    expect(world.perspectiveCamera?.cameraDirection).toEqual(local.perspectiveCamera?.cameraDirection);

    const plane = local.clippingPlanes?.[0];
    expect(plane).toBeDefined();
    expectClose(world.clippingPlanes?.[0].location, {
      x: plane!.location.x + ox, y: plane!.location.y + oy, z: plane!.location.z + oz,
    });
    expect(world.clippingPlanes?.[0].direction).toEqual(plane!.direction);
  });

  it('extractViewpointState turns a world viewpoint back into the getCamera() frame', async () => {
    const bcf = new BCFNamespace(viewerWithOffset(OFFSET));
    const world = await bcf.createViewpoint({ camera: CAMERA, sectionPlane: SECTION, bounds: BOUNDS });
    const state = await bcf.extractViewpointState(world, BOUNDS);

    const pos = state.camera!.position;
    expect(pos[0]).toBeCloseTo(CAMERA.position[0], 6);
    expect(pos[1]).toBeCloseTo(CAMERA.position[1], 6);
    expect(pos[2]).toBeCloseTo(CAMERA.position[2], 6);
    expect(state.sectionPlane?.axis).toBe('y');
    expect(state.sectionPlane?.position).toBeCloseTo(SECTION.position, 6);
  });

  it('reads a world viewpoint from another tool into the render frame even without bounds', async () => {
    const [ox, oy, oz] = OFFSET;
    const foreign = {
      guid: 'foreign',
      perspectiveCamera: {
        cameraViewPoint: { x: 12 + ox, y: 4 + oy, z: 8 + oz },
        cameraDirection: { x: 0, y: 1, z: 0 },
        cameraUpVector: { x: 0, y: 0, z: 1 },
        fieldOfView: 60,
        aspectRatio: 1.5,
      },
    };
    const state = await new BCFNamespace(viewerWithOffset(OFFSET)).extractViewpointState(foreign);
    expect(state.camera!.position[0]).toBeCloseTo(12, 6);
    expect(state.camera!.position[1]).toBeCloseTo(8, 6);
    expect(state.camera!.position[2]).toBeCloseTo(-4, 6);
  });

  it('keeps an ifc-lite viewpoint written before #4806 (still render frame) in place', async () => {
    const legacy = await new BCFNamespace().createViewpoint({ camera: CAMERA });
    const state = await new BCFNamespace(viewerWithOffset(OFFSET)).extractViewpointState(legacy, BOUNDS);
    expect(state.camera!.position).toEqual(CAMERA.position);
  });

  it('bim.bcf on a context uses that context\'s viewer', async () => {
    const backend = viewerWithOffset(OFFSET) as BimBackend;
    const bim = createBimContext({ backend });
    const vp = (await bim.bcf.createViewpoint({ camera: bim.viewer.getCamera() })) as Viewpoint;
    expect(vp.perspectiveCamera!.cameraViewPoint.x).toBeCloseTo(12 + OFFSET[0], 6);
  });

  it('a remote context, which cannot report a frame, still builds viewpoints (no offset)', async () => {
    const transport: Transport = {
      send: () => Promise.reject(new Error('createViewpoint must not need the transport')),
      subscribe: () => () => undefined,
      close: () => undefined,
    };
    const bim = createBimContext({ backend: new RemoteBackend(transport) });
    const vp = (await bim.bcf.createViewpoint({ camera: CAMERA })) as Viewpoint;
    expect(vp.perspectiveCamera!.cameraViewPoint).toEqual({ x: 12, y: 4, z: 8 });
  });
});
