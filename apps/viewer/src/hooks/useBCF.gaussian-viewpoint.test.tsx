/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8566: BCF operates on the shared camera and IFC components while a
 * Gaussian capture occupies a separate model slot. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBCFProject, createBCFTopic, readBCF, writeBCF, type BCFViewpoint } from '@ifc-lite/bcf';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import type { GaussianSplatModel } from './ingest/gaussianIngest.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { activeSectionPlane } from '@/store/section-active';
import { useBCF } from './useBCF.js';

const IFC_GUID = '0BCF8566ViewpointIfc000';
const CAPTURE_ID = 'capture-model-8566';
const SOURCE_MARKER = 'CAPTURE_SOURCE_BYTES_8566';
const POSITION = { x: 30, y: 20, z: 25 };
const TARGET = { x: 1, y: 2, z: 3 };
const BOUNDS = { min: { x: -10, y: 0, z: -8 }, max: { x: 10, y: 12, z: 8 } };
const SAVED_DIRECTION = {
  x: (TARGET.x - POSITION.x) / Math.hypot(TARGET.x - POSITION.x, TARGET.y - POSITION.y, TARGET.z - POSITION.z),
  y: (TARGET.y - POSITION.y) / Math.hypot(TARGET.x - POSITION.x, TARGET.y - POSITION.y, TARGET.z - POSITION.z),
  z: (TARGET.z - POSITION.z) / Math.hypot(TARGET.x - POSITION.x, TARGET.y - POSITION.y, TARGET.z - POSITION.z),
};
const FRAME_OFFSET = { x: 41266, y: 123, z: -308208 };
const PLACEMENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -41260, -120, 308204, 1];

let camera: Camera;
let api: ReturnType<typeof useBCF> | null = null;
let root: Root | null = null;

function Probe(): null {
  const renderer = { getCamera: () => camera } as Renderer;
  api = useBCF({ rendererRef: { current: renderer } });
  return null;
}

function models(captureVisible: boolean): [FederatedModel, FederatedModel] {
  const geometryResult: GeometryResult = {
    meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: {
      originShift: { x: 6, y: 3, z: -4 },
      wasmRtcOffset: { x: 41260, y: 308204, z: 120 },
      originalBounds: BOUNDS, shiftedBounds: BOUNDS, hasLargeCoordinates: true,
    },
  };
  const ifc = { ...fixtureModel('ifc', { entities: [{ expressId: 7, type: 'IfcWall', globalId: IFC_GUID }] }), loadedAt: 1, geometryResult } as FederatedModel;
  const gaussianSplat: GaussianSplatModel = {
    handle: { id: 8566 } as unknown as GaussianSplatModel['handle'],
    format: 'splat', count: 1, shDegree: 0,
    sourceCenterBounds: { min: [0, 0, 0], max: [1, 1, 1] },
    placement: PLACEMENT, sourcePlacement: [...PLACEMENT], upAxis: 'y',
    frameOffset: FRAME_OFFSET, placementOrigin: 'explicit', calibration: 'uncalibrated',
  };
  const capture = {
    ...fixtureModel(CAPTURE_ID), ifcDataStore: null, loadedAt: 2,
    visible: captureVisible, gaussianSplat,
    sourceFile: new File([SOURCE_MARKER], 'capture.splat'),
  } as FederatedModel;
  return [ifc, capture];
}

const state = () => useViewerStore.getState();

beforeEach(async () => {
  camera = new Camera();
  camera.setPosition(POSITION.x, POSITION.y, POSITION.z);
  camera.setTarget(TARGET.x, TARGET.y, TARGET.z);
  camera.setAspect(16 / 9);
  useViewerStore.setState({
    ...fixtureModels(...models(true)),
    geometryResult: null, ifcDataStore: null,
    isolatedEntities: null, hiddenEntities: new Set(),
    selectedEntityId: null, selectedEntityIds: new Set(),
    activeTool: 'select',
  });
  state().setSectionPlaneEnabled(false);
  useViewerStore.setState({ sectionPlane: { ...state().sectionPlane, custom: undefined, flipped: false } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  assert.ok(api);
});

afterEach(async () => {
  const current = root;
  root = null;
  api = null;
  if (current) await act(async () => current.unmount());
});

async function createViewpoint(): Promise<BCFViewpoint> {
  let viewpoint: BCFViewpoint | null = null;
  await act(async () => { viewpoint = await api!.createViewpointFromState({ includeSnapshot: false }); });
  assert.ok(viewpoint);
  return viewpoint;
}

function assertNear(actual: { x: number; y: number; z: number }, expected: { x: number; y: number; z: number }): void {
  assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y, actual.z - expected.z) < 1e-6,
    `${JSON.stringify(actual)} differs from ${JSON.stringify(expected)}`);
}

function viewDirection(): { x: number; y: number; z: number } {
  const position = camera.getPosition();
  const target = camera.getTarget();
  const length = Math.hypot(target.x - position.x, target.y - position.y, target.z - position.z);
  return { x: (target.x - position.x) / length, y: (target.y - position.y) / length, z: (target.z - position.z) / length };
}

function assertDirection(): void {
  const actual = viewDirection();
  assert.ok(Math.hypot(actual.x - SAVED_DIRECTION.x, actual.y - SAVED_DIRECTION.y, actual.z - SAVED_DIRECTION.z) < 1e-9,
    `restored view direction ${JSON.stringify(actual)} differs from ${JSON.stringify(SAVED_DIRECTION)}`);
}

async function serialized(viewpoint: BCFViewpoint): Promise<string> {
  const project = createBCFProject({ name: 'Gaussian viewpoint', version: '2.1' });
  const topic = createBCFTopic({ title: 'Capture in scene', author: 'test@example.invalid' });
  topic.viewpoints.push(viewpoint);
  project.topics.set(topic.guid, topic);
  const read = await readBCF(await writeBCF(project));
  return JSON.stringify([...read.topics.values()][0]?.viewpoints[0]);
}

describe('useBCF viewpoint with a Gaussian capture loaded (#8566)', () => {
  it('restores camera and clipping after the animated transition while leaving the capture intact', async () => {
    assert.ok(Object.values(FRAME_OFFSET).some((n) => n !== 0), 'the shared render frame is offset');
    await act(async () => {
      state().setActiveTool('section');
      state().setSectionPlaneAxis('down');
      state().setSectionPlanePosition(25);
    });
    const captured = await createViewpoint();
    assert.equal(captured.clippingPlanes?.length, 1);
    assert.ok(captured.perspectiveCamera);
    const captureBefore = state().models.get(CAPTURE_ID);
    assert.ok(captureBefore?.gaussianSplat);
    const placementBefore = [...captureBefore.gaussianSplat.placement];

    camera.setPosition(-40, 5, 2);
    camera.setTarget(8, 9, 10);
    assert.ok(Math.abs(camera.getDistance() - Math.hypot(TARGET.x - POSITION.x, TARGET.y - POSITION.y, TARGET.z - POSITION.z)) > 1,
      'the live orbit distance differs from capture');
    await act(async () => {
      state().setSectionPlaneAxis('side');
      state().setSectionPlanePosition(80);
      api!.applyViewpoint(captured, true);
    });
    assert.equal(camera.isTweening(), true, 'apply starts the real camera tween');
    // Camera.animateTo resolves only after Camera.update applies its final pose.
    await new Promise((resolve) => setTimeout(resolve, 325));
    camera.update(0);
    assert.equal(camera.isTweening(), false, 'the camera transition has settled');
    assertNear(camera.getPosition(), POSITION);
    assertDirection();
    const restored = activeSectionPlane(state());
    assert.ok(restored);
    assert.equal(restored.axis, 'down');
    assert.ok(Math.abs(restored.position - 25) < 1e-6);
    assert.deepEqual(state().models.get(CAPTURE_ID)?.gaussianSplat?.placement, placementBefore);
    assert.equal(state().models.get(CAPTURE_ID)?.visible, true);
    const xmlValue = await serialized(captured);
    for (const forbidden of [CAPTURE_ID, SOURCE_MARKER, 'capture.splat']) {
      assert.equal(xmlValue.includes(forbidden), false, `${forbidden} must not enter the BCF viewpoint`);
    }
    assert.deepEqual(captured.components?.selection ?? [], []);
    assert.deepEqual(captured.components?.visibility?.exceptions ?? [], []);

    // The nonanimated path restores the same saved position and direction.
    camera.setPosition(80, -10, 9);
    camera.setTarget(81, -10, 9);
    await act(async () => {
      state().setSectionPlaneAxis('side');
      state().setSectionPlanePosition(80);
      api!.applyViewpoint(captured, false);
    });
    assert.equal(camera.isTweening(), false);
    assertNear(camera.getPosition(), POSITION);
    assertDirection();
    const immediateCut = activeSectionPlane(state());
    assert.ok(immediateCut);
    assert.equal(immediateCut.axis, 'down');
    assert.ok(Math.abs(immediateCut.position - 25) < 1e-6);
    assert.deepEqual(state().models.get(CAPTURE_ID)?.gaussianSplat?.placement, placementBefore);
    assert.equal(state().models.get(CAPTURE_ID)?.visible, true);
  });

  it('cannot encode a hidden non-IFC capture as BCF visibility and leaves its model toggle hidden', async () => {
    await act(async () => useViewerStore.setState({ ...fixtureModels(...models(false)) }));
    const captured = await createViewpoint();
    assert.equal(captured.components?.visibility, undefined,
      'BCF visibility addresses IFC GlobalIds, not model-level capture toggles');
    await act(async () => api!.applyViewpoint(captured, false));
    assert.equal(state().models.get(CAPTURE_ID)?.visible, false);
    assert.equal((await serialized(captured)).includes(CAPTURE_ID), false);
  });
});
