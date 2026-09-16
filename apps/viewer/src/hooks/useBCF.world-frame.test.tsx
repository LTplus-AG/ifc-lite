/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF viewpoints are written and read in IFC world coordinates (#4806).
 *
 * The reporter's georeferenced model sits near X 41266 / Y 308208 / Z 123.
 * The geometry pipeline draws it near the origin (wasm RTC offset plus
 * `CoordinateHandler`'s origin shift), and `useBCF` handed that render-frame
 * camera straight to `createViewpoint`. BIMcollab and usBIM then put the
 * camera ~300 km from the building, so "the camera doesn't jump to the
 * objects". Reading their world camera raw did the same in reverse.
 *
 * These tests drive the real hook with a renderer stub whose camera is in the
 * render frame, and a model whose `coordinateInfo` records both shifts.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import type { GeometryResult } from '@ifc-lite/geometry';
import {
  createBCFProject,
  createBCFTopic,
  readBCF,
  writeBCF,
  type BCFViewpoint,
} from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useBCF } from './useBCF.js';

/** Centroid shift, recorded in RENDERER (Y-up) axes. */
const ORIGIN_SHIFT = { x: 6, y: 3, z: -4 };
/** Wasm RTC offset, recorded in IFC (Z-up) axes. */
const WASM_RTC = { x: 41260, y: 308204, z: 120 };
/** Render frame -> world, in BCF/IFC Z-up axes, worked out by hand:
 *  Y-up total = (6 + 41260, 3 + 120, -4 - 308204) = (41266, 123, -308208);
 *  as Z-up (x, -z, y) = (41266, 308208, 123). */
const WORLD = { x: 41266, y: 308208, z: 123 };

/** Local (render-frame, Y-up) model bounds the renderer draws. */
const LOCAL_BOUNDS = { min: { x: -10, y: 0, z: -8 }, max: { x: 10, y: 12, z: 8 } };

const LOCAL_POSITION = { x: 30, y: 20, z: 25 };
const LOCAL_TARGET = { x: 1, y: 2, z: 3 };
const LOCAL_DISTANCE = Math.hypot(29, 18, 22);

const TOL = 1e-6;

let applied: { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } } | null;

const renderer = {
  getCamera: () => ({
    getPosition: () => LOCAL_POSITION,
    getTarget: () => LOCAL_TARGET,
    getUp: () => ({ x: 0, y: 1, z: 0 }),
    getFOV: () => Math.PI / 4,
    getAspect: () => 16 / 9,
    getDistance: () => LOCAL_DISTANCE,
    setPosition: (x: number, y: number, z: number) => {
      applied = { position: { x, y, z }, target: applied?.target ?? { x: NaN, y: NaN, z: NaN } };
    },
    setTarget: (x: number, y: number, z: number) => {
      applied = { position: applied?.position ?? { x: NaN, y: NaN, z: NaN }, target: { x, y, z } };
    },
  }),
} as unknown as Renderer;

function geoModel(): FederatedModel {
  const geometryResult: GeometryResult = {
    meshes: [],
    totalVertices: 0,
    totalTriangles: 0,
    coordinateInfo: {
      originShift: ORIGIN_SHIFT,
      originalBounds: LOCAL_BOUNDS,
      shiftedBounds: LOCAL_BOUNDS,
      hasLargeCoordinates: true,
      wasmRtcOffset: WASM_RTC,
    },
  };
  return { ...fixtureModel('geo'), loadedAt: 1, geometryResult } as FederatedModel;
}

let api: ReturnType<typeof useBCF> | null = null;
let root: Root | null = null;

function Probe(): null {
  api = useBCF({ rendererRef: { current: renderer } });
  return null;
}

beforeEach(async () => {
  applied = null;
  useViewerStore.setState({
    ...fixtureModels(geoModel()),
    geometryResult: null,
    ifcDataStore: null,
    isolatedEntities: null,
    hiddenEntities: new Set(),
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    clashHighlightColors: null,
    sectionPlane: { ...useViewerStore.getState().sectionPlane, enabled: false, custom: undefined },
  });
  const container = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(api, 'the probe must be mounted');
});

afterEach(async () => {
  const current = root;
  root = null;
  api = null;
  if (current) await act(async () => current.unmount());
});

async function capture(): Promise<BCFViewpoint> {
  let viewpoint: BCFViewpoint | null = null;
  await act(async () => {
    viewpoint = await api!.createViewpointFromState({ includeSnapshot: false });
  });
  assert.ok(viewpoint, 'a viewpoint must be produced');
  return viewpoint;
}

function assertNear(actual: { x: number; y: number; z: number } | undefined, expected: { x: number; y: number; z: number }, message: string): void {
  assert.ok(actual, message);
  const d = Math.hypot(actual.x - expected.x, actual.y - expected.y, actual.z - expected.z);
  assert.ok(d < TOL, `${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} (off by ${d})`);
}

/** Viewer Y-up -> BCF Z-up, written out independently of production code. */
function bcf(p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: p.x, y: -p.z, z: p.y };
}

describe('useBCF — viewpoints are in IFC world coordinates (#4806)', () => {
  it('writes the camera at world coordinates, not the render frame', async () => {
    const viewpoint = await capture();
    const local = bcf(LOCAL_POSITION);
    assertNear(
      viewpoint.perspectiveCamera?.cameraViewPoint,
      { x: local.x + WORLD.x, y: local.y + WORLD.y, z: local.z + WORLD.z },
      'BUG: CameraViewPoint is in the origin-shifted render frame',
    );
    // A shift never turns the camera: the direction still points at the target.
    const dir = bcf({ x: LOCAL_TARGET.x - LOCAL_POSITION.x, y: LOCAL_TARGET.y - LOCAL_POSITION.y, z: LOCAL_TARGET.z - LOCAL_POSITION.z });
    const len = Math.hypot(dir.x, dir.y, dir.z);
    assertNear(viewpoint.perspectiveCamera?.cameraDirection, { x: dir.x / len, y: dir.y / len, z: dir.z / len }, 'direction');
  });

  it('writes the section plane location at world coordinates', async () => {
    await act(async () => {
      useViewerStore.setState({
        sectionPlane: { ...useViewerStore.getState().sectionPlane, enabled: true, axis: 'down', position: 25, flipped: false, custom: undefined },
      });
    });
    const viewpoint = await capture();
    // 25 % up the local Y range 0..12 is local y = 3, at the bounds' XZ centre.
    const local = bcf({ x: 0, y: 3, z: 0 });
    assertNear(
      viewpoint.clippingPlanes?.[0]?.location,
      { x: local.x + WORLD.x, y: local.y + WORLD.y, z: local.z + WORLD.z },
      'BUG: ClippingPlane Location is in the render frame',
    );
  });

  it('round-trips export then import back onto the local camera and section plane', async () => {
    await act(async () => {
      useViewerStore.setState({
        sectionPlane: { ...useViewerStore.getState().sectionPlane, enabled: true, axis: 'down', position: 25, flipped: false, custom: undefined },
      });
    });
    const viewpoint = await capture();
    await act(async () => {
      useViewerStore.setState({
        sectionPlane: { ...useViewerStore.getState().sectionPlane, enabled: true, axis: 'side', position: 90, flipped: false },
      });
    });
    await act(async () => api!.applyViewpoint(viewpoint, false));
    assertNear(applied?.position, LOCAL_POSITION, 'camera position restored in the render frame');
    assertNear(applied?.target, LOCAL_TARGET, 'camera target restored in the render frame');
    const plane = useViewerStore.getState().sectionPlane;
    assert.equal(plane.axis, 'down');
    assert.ok(Math.abs(plane.position - 25) < 1e-6, `section plane position restored, got ${plane.position}`);
  });

  it('imports another tool’s world-coordinate .bcfv onto the local model', async () => {
    // What BIMcollab writes for this model: a camera 15 m south-east of the
    // world-space model centre, looking at it.
    const worldCentre = { x: WORLD.x, y: WORLD.y, z: WORLD.z + 6 };
    const eye = { x: worldCentre.x + 15, y: worldCentre.y - 15, z: worldCentre.z + 5 };
    const d = { x: worldCentre.x - eye.x, y: worldCentre.y - eye.y, z: worldCentre.z - eye.z };
    const len = Math.hypot(d.x, d.y, d.z);
    const project = createBCFProject({ name: 'From another tool', version: '2.1' });
    const topic = createBCFTopic({ title: 'Clash', author: 'other@example.invalid' });
    topic.viewpoints.push({
      guid: '22222222-2222-4222-8222-222222222222',
      perspectiveCamera: {
        cameraViewPoint: eye,
        cameraDirection: { x: d.x / len, y: d.y / len, z: d.z / len },
        cameraUpVector: { x: 0, y: 0, z: 1 },
        fieldOfView: 60,
      },
    });
    project.topics.set(topic.guid, topic);
    const read = await readBCF(await writeBCF(project));
    const imported = [...read.topics.values()][0]?.viewpoints[0];
    assert.ok(imported, 'the .bcfv must read back');

    await act(async () => api!.applyViewpoint(imported, false));
    // World eye minus the offset, in viewer axes: (15, 11, 15).
    assertNear(applied?.position, { x: 15, y: 11, z: 15 }, 'BUG: the imported world camera was applied raw');
  });

  it('still reads a viewpoint an older ifc-lite wrote in the render frame', async () => {
    const legacy: BCFViewpoint = {
      guid: '33333333-3333-4333-8333-333333333333',
      perspectiveCamera: {
        cameraViewPoint: bcf(LOCAL_POSITION),
        cameraDirection: { x: 0, y: 1, z: 0 },
        cameraUpVector: { x: 0, y: 0, z: 1 },
        fieldOfView: 45,
      },
    };
    await act(async () => api!.applyViewpoint(legacy, false));
    assertNear(applied?.position, LOCAL_POSITION, 'a pre-#4806 render-frame camera must not be shifted 300 km away');
  });
});
