/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Renderer.getPickGeometryRevision()` (#8998): the viewer's Measure Point
 * "Live" reading compares it to tell whether a pick at a resting cursor could
 * now hit something else. It must change on every change to what a CPU pick
 * walks (an edit or its undo, a moved element, geometry streaming in, a
 * model placed or unloaded), and must not change on work that leaves the
 * pickable geometry alone: a selection's highlight meshes, an idle frame's
 * batch check.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Renderer } from './index.js';
import type { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';

(globalThis as Record<string, unknown>).GPUBufferUsage ??= {
  COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
};

function triangle(expressId: number, x = 0): MeshData {
  return { expressId, modelIndex: 0, origin: [x, 0, 0], color: [1, 1, 1, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]) };
}

/** A renderer over a GPU stand-in that accepts every upload. */
function setup() {
  const renderer = new Renderer({ width: 256, height: 256,
    getBoundingClientRect: () => ({ width: 256, height: 256 }) } as unknown as HTMLCanvasElement);
  const device = {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 },
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, destroy() {} }),
    createBindGroup: () => ({}),
    queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
  const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;
  const internals = renderer as unknown as { device: { isInitialized(): boolean; getDevice(): GPUDevice }; pipeline: RenderPipeline };
  internals.device = { isInitialized: () => true, getDevice: () => device };
  internals.pipeline = pipeline;
  const scene = renderer.getScene() as Scene;
  scene.appendToBatches([triangle(7), triangle(8, 5)], device, pipeline);
  /** Run `change`, and say whether the revision moved. */
  const bumps = (change: () => unknown): boolean => {
    const before = renderer.getPickGeometryRevision();
    change();
    return renderer.getPickGeometryRevision() !== before;
  };
  return { renderer, scene, device, pipeline, bumps };
}

describe('Renderer.getPickGeometryRevision (#8998)', () => {
  it('changes on every change to what a pick can hit', () => {
    const changes: Array<[string, (s: ReturnType<typeof setup>) => unknown]> = [
      ['an edit or its undo re-meshes an element', ({ scene, device, pipeline }) => {
        scene.removeMeshesForEntities([7]);
        scene.appendToBatches([triangle(7, 2)], device, pipeline, false);
      }],
      ['an edit removes an element', ({ scene }) => scene.removeMeshesForEntities([7])],
      ['a command moves an element', ({ scene }) => scene.translateMeshesForEntities(new Map([[7, [1, 0, 0]]]))],
      ['a command rotates an element', ({ scene }) => scene.rotateMeshesForEntities(new Map([[7, { angle: 0.5, pivot: [0, 0, 0] }]]))],
      ['geometry streams in', ({ scene, device, pipeline }) => scene.appendToBatches([triangle(9, 9)], device, pipeline, true)],
      ['a model is placed', ({ renderer }) => renderer.setModelTranslation(0, [3, 0, 0])],
      ['the scene is cleared', ({ scene }) => scene.clear()],
    ];
    for (const [name, change] of changes) {
      const s = setup();
      assert.equal(s.bumps(() => change(s)), true, `the revision missed: ${name}`);
    }
  });

  it('a streamed batch counts once the flush uploads it, not while it waits in the queue', () => {
    const { scene, device, pipeline, bumps } = setup();
    assert.equal(bumps(() => scene.queueMeshes([triangle(9, 9)])), false, 'a queued mesh is not pickable yet');
    assert.equal(bumps(() => scene.flushPending(device, pipeline)), true, 'the flush that makes it pickable missed');
  });

  it('meshes past the streaming fragment budget count when finalize first batches them', () => {
    const { scene, device, pipeline, bumps } = setup();
    scene.limitStreamingFragments(0); // a cache hit: the rest join their buckets and wait for finalize
    scene.appendToBatches([triangle(9, 9)], device, pipeline, true);
    assert.equal(bumps(() => scene.finalizeStreaming(device, pipeline)), true, 'finalize made them pickable without a bump');
  });

  it('keeps still for work that leaves the pickable geometry alone', () => {
    const { renderer, scene, device, pipeline, bumps } = setup();
    const still: Array<[string, () => unknown]> = [
      ['a selection hydrates its highlight mesh', () => renderer.createMeshFromData(scene.getMeshDataPieces(7)![0])],
      ['an idle frame finds no batch to rebuild', () => scene.rebuildPendingBatches(device, pipeline)],
      ['an idle frame finds nothing queued', () => scene.flushPending(device, pipeline)],
      ['a zero move', () => scene.translateMeshesForEntities(new Map([[7, [0, 0, 0]]]))],
      ['a move of an id the scene does not hold', () => scene.translateMeshesForEntities(new Map([[99, [1, 0, 0]]]))],
      ['the placement it already has', () => renderer.setModelTranslation(0, [0, 0, 0])],
      ['a pick', () => renderer.raycastScene(128, 128)],
      ['a recolour', () => { scene.updateMeshColors(new Map([[7, [1, 0, 0, 1]]]), device, pipeline); scene.rebuildPendingBatches(device, pipeline); }],
    ];
    for (const [name, change] of still) assert.equal(bumps(change), false, `the revision churned on: ${name}`);
  });
});
