/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A move or rotate command's delta moves flat pieces' positions IN PLACE, so
 * every piece keeps its identity. The renderer's raycast index keeps its BVH
 * when a revision bump leaves the same pieces (#9504), so the drain must drop
 * the caches or a moved element stays pickable only where it used to be
 * (#9512 review). Driven through the drain over a real renderer.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef } from 'react';
import { Renderer, type RenderPipeline } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { cleanup, render } from '@/test/render.js';
import { usePlacementMutationDrain } from './usePlacementMutationDrain.js';

afterEach(cleanup);
Object.assign(globalThis, { GPUBufferUsage: { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 } });

const triangle = (expressId: number, x: number): MeshData => ({
  expressId, modelIndex: 0, origin: [x, 0, 0], color: [1, 1, 1, 1],
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
});

/** Element 7 at the origin, plus enough pieces far to -X to cross the BVH threshold. */
function movableScene() {
  const renderer = new Renderer({ width: 256, height: 256,
    getBoundingClientRect: () => ({ width: 256, height: 256 }) } as unknown as HTMLCanvasElement);
  const device = {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 },
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, destroy() {} }),
    createBindGroup: () => ({}),
    queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
  const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;
  Object.assign(renderer, { device: { isInitialized: () => true, getDevice: () => device }, pipeline });
  const pieces = [triangle(7, 0)];
  for (let i = 0; i < 120; i++) pieces.push(triangle(100 + i, -1_000 - i * 20));
  renderer.getScene().appendToBatches(pieces, device, pipeline);
  return renderer;
}

/** Pick through the canvas centre, looking straight down -Z at (x, y). */
function pickAt(renderer: Renderer, x: number, y: number): number | undefined {
  const camera = renderer.getCamera();
  camera.setAspect(1);
  camera.setProjectionMode('orthographic');
  camera.setOrthoSize(2);
  camera.setPosition(x, y, 50);
  camera.setTarget(x, y, 0);
  camera.setUp(0, 1, 0);
  return renderer.raycastScene(128, 128)?.intersection.expressId;
}

function MoveDrain({ renderer, pending }: { renderer: Renderer; pending: Map<number, [number, number, number]> }) {
  usePlacementMutationDrain({
    rendererRef: useRef<Renderer | null>(renderer), isInitialized: true, gpuRecoveryEpoch: 0,
    kind: 'translations', pending, clearPending: () => {},
  });
  return null;
}

describe('usePlacementMutationDrain', () => {
  it('a moved element is picked where it now is, not where it was (#9512)', () => {
    const renderer = movableScene();
    assert.equal(pickAt(renderer, 0.25, 0.25), 7, 'setup: the element is picked before the move');
    assert.equal(pickAt(renderer, 5.25, 0.25), undefined, 'setup: nothing at the destination yet');

    render(<MoveDrain renderer={renderer} pending={new Map([[7, [5, 0, 0]]])} />);

    assert.equal(pickAt(renderer, 5.25, 0.25), 7, 'the moved element is not pickable at its new place');
    assert.equal(pickAt(renderer, 0.25, 0.25), undefined, 'the moved element is still pickable at its old place');
  });
});
