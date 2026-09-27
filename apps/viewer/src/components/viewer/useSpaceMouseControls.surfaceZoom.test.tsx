/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5924 - the SpaceMouse dolly stops short of the surface at the viewport
 * centre, like the toolbar zoom-in (`zoomSurface.centreZoom.test.ts`), the
 * wheel (#5393) and touch pinch (#5547).
 *
 * Mounts the real hook against a real `Camera`. A fake granted HID device
 * (legacy report layout) is reopened on mount, as a returning user's is, and
 * each frame sends a translation report with the cap pushed forward, then runs
 * the hook's animation frame. So the whole path (session, 6DoF mapping, gate,
 * pick cache, `Camera.zoom(..., surfacePoint)`) is exercised.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { render, cleanup } from '@/test/render.js';
import { AXIS_FULL_SCALE, MAX_FRAME_DELTA_MS, REPORT_ID_TRANSLATION } from '@/lib/spacemouse/constants';
import { useSpaceMouseControls, type UseSpaceMouseControlsParams } from './useSpaceMouseControls.js';

const WALL_Z = 2;
const ref = <T,>(current: T) => ({ current });

let clock = 0;
let frames: FrameRequestCallback[] = [];
const saved = { now: performance.now, dateNow: Date.now, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };

function fakeDevice(): HIDDevice {
  const device = new EventTarget() as unknown as Record<string, unknown>;
  Object.assign(device, { vendorId: 0x256f, productId: 0xc635, productName: 'Fake', opened: true, collections: [],
    open: async () => {}, close: async () => {} });
  return device as unknown as HIDDevice;
}

/** Translation report: tx, ty, tz as int16 LE. ty < 0 is the cap pushed forward (zoom in). */
function sendTranslation(device: HIDDevice, ty: number): void {
  const data = new DataView(new ArrayBuffer(6));
  data.setInt16(2, ty, true);
  const event = Object.assign(new Event('inputreport'), { reportId: REPORT_ID_TRANSLATION, data, device });
  (device as unknown as EventTarget).dispatchEvent(event);
}

interface RigOptions { hit?: boolean; isStreaming?: boolean }

async function rig(opts: RigOptions = {}) {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 });
  const camera = new Camera();
  camera.setAspect(800 / 600);
  camera.setPosition(0, 0, 10);
  camera.setTarget(0, 0, 0);
  const raycasts: Array<[number, number]> = [];
  const renderer = {
    getCamera: () => camera, getCanvas: () => canvas, requestRender() {},
    getScene: () => ({ getMeshes: () => [], getBatchedMeshes: () => [], getInstancedEntityCount: () => 10 }),
    raycastScene: (x: number, y: number) => {
      raycasts.push([x, y]);
      return opts.hit === false ? null : { intersection: { point: { x: 0, y: 0, z: WALL_Z } } };
    },
  } as unknown as Renderer;
  const device = fakeDevice();
  const hid = Object.assign(new EventTarget(), { getDevices: async () => [device], requestDevice: async () => [device] });
  Object.defineProperty(navigator, 'hid', { value: hid, configurable: true });
  const params: UseSpaceMouseControlsParams = {
    rendererRef: ref(renderer), isInitialized: true, selectedEntityIdRef: ref(null), calculateScale() {},
    geometryRef: ref(null),
    getPickOptions: () => ({ isStreaming: opts.isStreaming ?? false, hiddenIds: new Set<number>(), isolatedIds: null }),
  };
  function Probe() { useSpaceMouseControls(params); return null; }
  render(<Probe />);
  // The granted device reopens asynchronously, then the loop requests a frame.
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  assert.equal(frames.length, 1, 'the SpaceMouse session started its frame loop');

  /** `n` frames with the cap held at `ty`; the camera z after each. */
  const hold = (ty: number, n: number) => Array.from({ length: n }, () => {
    clock += MAX_FRAME_DELTA_MS;
    sendTranslation(device, ty);
    const run = frames;
    frames = [];
    run.forEach((cb) => cb(clock));
    return camera.getPosition().z;
  });
  return { camera, raycasts, hold };
}

describe('SpaceMouse dolly stops short of the surface at the viewport centre (#5924)', () => {
  beforeEach(() => {
    clock = 1_000;
    frames = [];
    performance.now = () => clock;
    Date.now = () => clock; // the cached pick's age reads Date.now
    globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
    globalThis.cancelAnimationFrame = () => { frames = []; };
  });
  afterEach(() => {
    cleanup();
    performance.now = saved.now;
    Date.now = saved.dateNow;
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    Reflect.deleteProperty(navigator, 'hid');
  });

  it('without a surface hit, holding the cap forward passes through the wall (the defect)', async () => {
    const zs = (await rig({ hit: false })).hold(-AXIS_FULL_SCALE, 60);
    assert.ok(zs[0] < 10, 'pushing the cap forward must zoom in');
    assert.ok(Math.min(...zs) < WALL_Z, `plain zoom never passed the wall: min z ${Math.min(...zs)}`);
  });

  it('with a surface hit, holding the cap forward approaches the wall and never passes it', async () => {
    const r = await rig();
    const zs = r.hold(-AXIS_FULL_SCALE, 150);
    zs.forEach((z, i) => assert.ok(z > WALL_Z, `frame ${i}: camera at z ${z} is at or behind the wall`));
    for (let i = 1; i < zs.length; i++) assert.ok(zs[i] <= zs[i - 1], `frame ${i} moved away from the wall`);
    assert.ok(zs[zs.length - 1] - WALL_Z < 0.1, `${zs.length} frames got close to the wall: z ${zs[zs.length - 1]}`);
    assert.ok(r.raycasts.every(([x, y]) => x === 400 && y === 300), 'raycasts at the viewport centre in CSS px');
    // Re-picked by age while held (every SURFACE_PICK_IDLE_MS of the 7.5 s
    // hold), not once per frame. Bounded rather than imported so this file
    // loads against the unfixed hook and the revert oracle sees it go red.
    assert.ok(r.raycasts.length > 1 && r.raycasts.length <= 150 / 4, `${r.raycasts.length} raycasts in 150 frames`);
  });

  it('a hold that began while streaming stops short of the wall once streaming ends', async () => {
    const opts: RigOptions = { isStreaming: true };
    const r = await rig(opts);
    r.hold(-AXIS_FULL_SCALE, 2);
    opts.isStreaming = false;
    const zs = r.hold(-AXIS_FULL_SCALE, 150);
    assert.ok(r.raycasts.length > 0, 'the held dolly never picked after streaming ended');
    zs.forEach((z, i) => assert.ok(z > WALL_Z, `frame ${i}: camera at z ${z} is at or behind the wall`));
  });

  it('never raycasts when pulling the cap back (zoom out)', async () => {
    const r = await rig();
    r.hold(AXIS_FULL_SCALE, 10);
    assert.ok(r.camera.getPosition().z > 10, 'pulling the cap back must zoom out');
    assert.equal(r.raycasts.length, 0);
  });

  it('skips the raycast while streaming and still zooms (plain)', async () => {
    const r = await rig({ isStreaming: true });
    const zs = r.hold(-AXIS_FULL_SCALE, 5);
    assert.equal(r.raycasts.length, 0);
    assert.ok(zs[zs.length - 1] < 10);
  });
});
