/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8814: a restored BCF camera must survive capture through the real viewer hook. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { createViewpoint, type BCFViewpoint } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import { useBCF } from './useBCF.js';

type Vec3 = { x: number; y: number; z: number };
const POSITION = { x: 12, y: 8, z: 20 };
const TARGET = { x: 1, y: 2, z: 3 };
const UP = { x: 0.6, y: 0.8, z: 0 };
const FOV = 61 * Math.PI / 180;
const ORTHO_SIZE = 23.5;
let camera: Camera;
let api: ReturnType<typeof useBCF> | null = null;
let root: Root | null = null;
let now = 1000;
let frames: FrameRequestCallback[] = [];
const originalNow = Date.now;
const originalRaf = globalThis.requestAnimationFrame;

function Probe({ renderer }: { renderer: Renderer }): null {
  api = useBCF({ rendererRef: { current: renderer } });
  return null;
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} != ${expected}`);
}

function nearVec(actual: Vec3, expected: Vec3, tolerance: number, label: string): void {
  near(actual.x, expected.x, tolerance, `${label}.x`);
  near(actual.y, expected.y, tolerance, `${label}.y`);
  near(actual.z, expected.z, tolerance, `${label}.z`);
}

function source(orthographic: boolean): BCFViewpoint {
  return createViewpoint({ camera: {
    position: POSITION, target: TARGET, up: UP, fov: FOV,
    isOrthographic: orthographic, orthoScale: ORTHO_SIZE, aspectRatio: 16 / 9,
  } });
}

async function capture(): Promise<BCFViewpoint> {
  let result: BCFViewpoint | null = null;
  await act(async () => { result = await api!.createViewpointFromState({ includeSnapshot: false }); });
  assert.ok(result);
  return result;
}

beforeEach(async () => {
  camera = new Camera();
  camera.setPosition(0, 4, 10);
  camera.setTarget(0, 0, 0);
  camera.setAspect(16 / 9);
  now = 1000;
  frames = [];
  Date.now = () => now;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  };
  useViewerStore.setState({
    models: new Map(), geometryResult: null, ifcDataStore: null,
    isolatedEntities: null, hiddenEntities: new Set(),
    selectedEntityId: null, selectedEntityIds: new Set(),
    activeTool: 'select',
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const renderer = { getCamera: () => camera } as unknown as Renderer;
  await act(async () => { root!.render(<Probe renderer={renderer} />); });
  assert.ok(api);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  api = null;
  Date.now = originalNow;
  globalThis.requestAnimationFrame = originalRaf;
});

describe('useBCF camera roundtrip (#8814)', () => {
  for (const orthographic of [false, true]) {
    for (const animate of [false, true]) {
      it(`${orthographic ? 'orthographic' : 'perspective'} viewpoint, animate=${animate}`, async () => {
        const viewpoint = source(orthographic);
        await act(async () => { api!.applyViewpoint(viewpoint, animate); });
        if (animate) {
          assert.equal(camera.isTweening(), true);
          now += 300;
          camera.update(0);
          assert.equal(camera.isTweening(), false);
          const pending = frames;
          frames = [];
          for (const frame of pending) frame(now);
          // Camera's async wrapper and the restore callback each add a promise
          // continuation after the animator's requestAnimationFrame poll.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.equal(camera.getProjectionMode(), orthographic ? 'orthographic' : 'perspective');
        nearVec(camera.getUp(), UP, 1e-9, 'restored up');
        if (orthographic) near(camera.getOrthoSize(), ORTHO_SIZE, 1e-6, 'restored half-height');
        else near(camera.getFOV(), FOV, 1e-6, 'restored FOV');

        const saved = await capture();
        const original = orthographic ? viewpoint.orthogonalCamera! : viewpoint.perspectiveCamera!;
        const roundtrip = orthographic ? saved.orthogonalCamera! : saved.perspectiveCamera!;
        assert.ok(roundtrip, 'capture must retain the projection mode');
        nearVec(roundtrip.cameraViewPoint, original.cameraViewPoint, 1e-9, 'eye');
        nearVec(roundtrip.cameraDirection, original.cameraDirection, 1e-9, 'direction');
        nearVec(roundtrip.cameraUpVector, original.cameraUpVector, 1e-9, 'up');
        if (orthographic) {
          near(saved.orthogonalCamera!.viewToWorldScale, ORTHO_SIZE, 1e-6, 'scale');
        } else {
          near(saved.perspectiveCamera!.fieldOfView, 61, 1e-6, 'FOV degrees');
        }
      });
    }
  }
});
