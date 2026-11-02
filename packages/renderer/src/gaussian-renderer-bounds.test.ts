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

(globalThis as Record<string, unknown>).GPUBufferUsage ??= { COPY_DST: 8, UNIFORM: 64, VERTEX: 32, INDEX: 16, STORAGE: 128, COPY_SRC: 4, MAP_READ: 1 };
(globalThis as Record<string, unknown>).GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

test('#8564 Gaussian visibility changes keep annotation framing bounds', async () => {
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

  const attributes = {
    count: 1, positions: new Float32Array([10, 10, 10]), scales: new Float32Array([1, 1, 1]), rotations: new Float32Array([1, 0, 0, 0]),
    colors: new Float32Array([1, 0, 0, 1]), opacities: new Float32Array([1]), sphericalHarmonics: new Float32Array(), sphericalHarmonicsDegree: 0 as const,
  };
  const handle = await renderer.gaussianSplats.add({ attributes, placement: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, modelIndex: 0 }, { qualification: 'internal-unqualified' });
  assert.deepEqual(renderer.getModelBounds(), annotation, 'an interior Gaussian does not change the bounds');
  renderer.gaussianSplats.setVisible(handle, false);
  assert.deepEqual(renderer.getModelBounds(), annotation, 'hiding keeps the annotation bounds');
  const camera = (fields.camera as { getSceneBounds(): unknown }).getSceneBounds();
  assert.ok(camera === null || JSON.stringify(camera) === JSON.stringify(annotation), 'the camera never received shrunken bounds');
  renderer.gaussianSplats.remove(handle);
  assert.deepEqual(renderer.getModelBounds(), annotation, 'removal keeps the annotation bounds');

  const outside = { ...attributes, positions: new Float32Array([500, 0, 0]) };
  await renderer.gaussianSplats.add({ attributes: outside, placement: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, modelIndex: 0 }, { qualification: 'internal-unqualified' });
  const grown = renderer.getModelBounds();
  assert.ok(grown && grown.max.x >= 500 && grown.min.x <= 0 && grown.max.y >= 100, 'a Gaussian outside the scene grows the bounds and keeps the annotation');
  assert.deepEqual((fields.camera as { getSceneBounds(): unknown }).getSceneBounds(), grown, 'the camera receives the grown bounds');
});
