/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 review round 3: hiding or removing a Gaussian must not shrink the renderer's
// framing bounds through the tracker's recompute, which drops annotation bounds.
// Drives the real Renderer facades; only GPU recording and the upstream backend are stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from './index.js';
import type { GaussianBackend } from './gaussian/gaussian-backend.js';
import { computeOrthoNearFar } from './camera-matrices.js';

(globalThis as Record<string, unknown>).GPUBufferUsage ??= { COPY_DST: 8, UNIFORM: 64, VERTEX: 32, INDEX: 16, STORAGE: 128, COPY_SRC: 4, MAP_READ: 1 };
(globalThis as Record<string, unknown>).GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

test('#8564 Gaussians never enter model bounds; only the orthographic depth range follows visible centres', async () => {
  const canvas = { width: 64, height: 64, getBoundingClientRect: () => ({ width: 64, height: 64 }), style: {} } as unknown as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  const fields = renderer as unknown as Record<string, unknown>;
  const raw = { limits: { maxBufferSize: 1 << 24, maxStorageBufferBindingSize: 1 << 24 } };
  fields.ready = true;
  fields.device = { isInitialized: () => true, getDevice: () => raw, getAdapter: () => null, destroy: () => {} };
  fields.pipeline = {};
  const backend = async (): Promise<GaussianBackend> => ({
    upstreamReverseZ: true,
    createScene: () => ({ gpuBytes: 64, async replaceSource() {}, updateRows() {}, setFilter() {}, encode() {}, destroy() {} }),
  });
  ((fields.gaussianLayer as Record<string, unknown>).slot as Record<string, unknown>).createBackend = backend;
  (fields.overlays as Record<string, unknown>).section2DOverlayRenderer = { setLineOverlay() {} };
  renderer.setLineOverlay('annotation', new Float32Array([0, 0, 0, 100, 100, 100]));
  const annotation = structuredClone(renderer.getModelBounds());
  assert.ok(annotation, 'annotation bounds exist');
  const camera = fields.camera as { getSceneBounds(): unknown; state: Parameters<typeof computeOrthoNearFar>[0] };

  const attributes = {
    count: 1, positions: new Float32Array([500, 0, 0]), scales: new Float32Array([1, 1, 1]), rotations: new Float32Array([1, 0, 0, 0]),
    colors: new Float32Array([1, 0, 0, 1]), opacities: new Float32Array([1]), sphericalHarmonics: new Float32Array(), sphericalHarmonicsDegree: 0 as const,
  };
  const handle = await renderer.gaussianSplats.add({ attributes, placement: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, modelIndex: 0 }, { qualification: 'internal-unqualified' });
  assert.deepEqual(renderer.getModelBounds(), annotation, 'a far Gaussian does not expand model bounds (fit fallbacks read them)');
  assert.deepEqual(camera.state.depthOnlyBounds, { min: { x: 500, y: 0, z: 0 }, max: { x: 500, y: 0, z: 0 } });
  // Looking down -Z from z=200 towards the origin: the far centre at x=500 must lie inside the orthographic depth range.
  camera.state.camera.position = { x: 0, y: 0, z: 200 }; camera.state.camera.target = { x: 0, y: 0, z: 0 };
  const range = computeOrthoNearFar(camera.state, 200);
  const sceneOnly = computeOrthoNearFar({ ...camera.state, depthOnlyBounds: null }, 200);
  assert.ok(range.far - range.near > sceneOnly.far - sceneOnly.near, 'the depth range widens for the visible Gaussian');
  renderer.gaussianSplats.setVisible(handle, false);
  assert.equal(camera.state.depthOnlyBounds, null, 'a hidden capture no longer widens the depth range');
  assert.deepEqual(renderer.getModelBounds(), annotation, 'hiding keeps the annotation bounds');
  renderer.gaussianSplats.remove(handle);
  assert.deepEqual(renderer.getModelBounds(), annotation, 'removal keeps the annotation bounds');
  assert.equal(camera.state.depthOnlyBounds, null);
});

test('#8564 review round 4: moving a Gaussian far away moves the depth extent with it', async () => {
  const canvas = { width: 64, height: 64, getBoundingClientRect: () => ({ width: 64, height: 64 }), style: {} } as unknown as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  const fields = renderer as unknown as Record<string, unknown>;
  fields.ready = true;
  fields.device = { isInitialized: () => true, getDevice: () => ({ limits: { maxBufferSize: 1 << 24, maxStorageBufferBindingSize: 1 << 24 } }), getAdapter: () => null, destroy: () => {} };
  fields.pipeline = {};
  ((fields.gaussianLayer as Record<string, unknown>).slot as Record<string, unknown>).createBackend = async (): Promise<GaussianBackend> => ({
    upstreamReverseZ: true,
    createScene: () => ({ gpuBytes: 64, async replaceSource() {}, updateRows() {}, setFilter() {}, encode() {}, destroy() {} }),
  });
  (fields.overlays as Record<string, unknown>).section2DOverlayRenderer = { setLineOverlay() {} };
  renderer.setLineOverlay('annotation', new Float32Array([0, 0, 0, 100, 100, 100]));
  const annotation = structuredClone(renderer.getModelBounds());
  const camera = fields.camera as { state: Parameters<typeof computeOrthoNearFar>[0] };
  const attributes = {
    count: 1, positions: new Float32Array([10, 10, 10]), scales: new Float32Array([1, 1, 1]), rotations: new Float32Array([1, 0, 0, 0]),
    colors: new Float32Array([1, 0, 0, 1]), opacities: new Float32Array([1]), sphericalHarmonics: new Float32Array(), sphericalHarmonicsDegree: 0 as const,
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const handle = await renderer.gaussianSplats.add({ attributes, placement: { matrix: identity }, modelIndex: 0 }, { qualification: 'internal-unqualified' });
  assert.equal(await renderer.gaussianSplats.setPlacement(handle, { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 500, 0, 0, 1] }), true);
  assert.deepEqual(camera.state.depthOnlyBounds, { min: { x: 510, y: 10, z: 10 }, max: { x: 510, y: 10, z: 10 } }, 'the moved, disjoint centre is the depth extent');
  assert.deepEqual(renderer.getModelBounds(), annotation, 'model bounds stay the annotation bounds');
});
