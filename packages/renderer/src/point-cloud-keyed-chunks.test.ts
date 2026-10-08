/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Removable (keyed) chunks inside one point-cloud asset (#6869): COPC LOD
 * streams octree nodes in and out of a single asset. Removing a key must
 * free exactly that key's GPU buffers, drop its points from the count, and
 * take its points out of measurement snapping, leaving every other key and
 * the asset's unkeyed points untouched.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { appendChunkToNode, createNode, destroyNode } from './pointcloud/point-cloud-node.js';
import { removeKeyedChunks } from './pointcloud/point-cloud-keyed-chunks.js';
import { buildRayQuerySources } from './pointcloud/point-cloud-ray-transform.js';
import { queryPointClouds } from './raycast-point-cloud-query.js';
import type { PointRenderPipeline } from './pointcloud/point-pipeline.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

type FakeBuffer = GPUBuffer & { destroyed: number };

/** `dispatchCap` forces the sub-buffer split (65535 x 64 points in a real device). */
function harness(dispatchCap = 65535) {
  const created: FakeBuffer[] = [];
  const device = {
    limits: { maxBufferSize: 256 << 20, maxStorageBufferBindingSize: 128 << 20, maxComputeWorkgroupsPerDimension: dispatchCap },
    queue: { writeBuffer: () => {} },
    createBuffer: () => {
      const buf = { size: 0, destroyed: 0, destroy() { this.destroyed++; } };
      created.push(buf as unknown as FakeBuffer);
      return buf as unknown as GPUBuffer;
    },
  } as unknown as GPUDevice;
  const pipeline = {
    createUniformBuffer: () => ({ destroy() {} }) as unknown as GPUBuffer,
    createBindGroup: () => ({}) as GPUBindGroup,
  } as unknown as PointRenderPipeline;
  return { device, created, node: createNode(device, pipeline, { expressId: 9 }) };
}

/** `n` points on a line at x = base .. base + n - 1. */
function line(base: number, n: number) {
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions[i * 3] = base + i;
  return {
    positions,
    pointCount: n,
    bbox: { min: [base, 0, 0] as [number, number, number], max: [base + n - 1, 0, 0] as [number, number, number] },
  };
}

const ALL = new Uint32Array(8).fill(0xffffffff);

/** Snap along -Z onto the point at (x, 0, 0) through every source. */
function snapsAt(node: ReturnType<typeof harness>['node'], x: number): boolean {
  for (const src of buildRayQuerySources([node], ALL)) {
    const hit = src.index.queryRay({ x, y: 0, z: 5 }, { x: 0, y: 0, z: -1 }, 100, () => 0.05);
    if (hit && Math.abs(hit.position.x - x) < 1e-6) return true;
  }
  return false;
}

describe('keyed point-cloud chunks (#6869)', () => {
  it('removing a key frees only its buffers, points and snap targets', () => {
    const { device, created, node } = harness();
    appendChunkToNode(device, node, line(0, 10)); // unkeyed (classic stream)
    appendChunkToNode(device, node, line(100, 20), 'a');
    appendChunkToNode(device, node, line(200, 30), 'b');
    assert.strictEqual(node.pointCount, 60);
    assert.ok(snapsAt(node, 105) && snapsAt(node, 205) && snapsAt(node, 5));

    const removed = removeKeyedChunks(node, 'a');

    assert.strictEqual(removed, 20);
    assert.strictEqual(node.pointCount, 40);
    assert.deepStrictEqual(node.chunks.map((c) => c.key ?? null), [null, 'b']);
    // Buffers are created in (vertex, deviation) pairs per chunk: unkeyed, a, b.
    assert.deepStrictEqual(created.map((b) => b.destroyed), [0, 0, 1, 1, 0, 0]);
    assert.strictEqual(snapsAt(node, 105), false, 'a removed node must not stay snappable');
    assert.ok(snapsAt(node, 205) && snapsAt(node, 5), 'other keys and unkeyed points stay snappable');
  });

  it('a key whose chunk was split into several GPU sub-buffers is removed whole', () => {
    const { device, created, node } = harness(1); // 64 points per sub-buffer
    appendChunkToNode(device, node, line(0, 200), 'big');
    assert.strictEqual(node.chunks.length, 4);
    assert.strictEqual(removeKeyedChunks(node, 'big'), 200);
    assert.strictEqual(node.chunks.length, 0);
    assert.ok(created.every((b) => b.destroyed === 1));
  });

  it('re-adding a key after removal works, and an unknown key is a no-op', () => {
    const { device, node } = harness();
    appendChunkToNode(device, node, line(0, 5), 'n');
    removeKeyedChunks(node, 'n');
    appendChunkToNode(device, node, line(50, 7), 'n');
    assert.strictEqual(node.pointCount, 7);
    assert.ok(snapsAt(node, 53));
    assert.strictEqual(snapsAt(node, 3), false);
    assert.strictEqual(removeKeyedChunks(node, 'never-added'), 0);
    assert.strictEqual(node.pointCount, 7);
  });

  it('destroying the asset releases keyed snap indexes too', () => {
    const { device, node } = harness();
    appendChunkToNode(device, node, line(0, 5), 'x');
    destroyNode(node);
    assert.strictEqual(node.keyedIndexes?.size ?? 0, 0);
    assert.deepStrictEqual(buildRayQuerySources([node], ALL), []);
  });
});

describe('snapping across keyed sources with different placements (#6880 review)', () => {
  it('the per-matrix ray rewrite is reused within an asset but never across assets', () => {
    const a = harness();
    const b = harness();
    appendChunkToNode(a.device, a.node, line(0, 3), 'n1');
    appendChunkToNode(a.device, a.node, line(10, 3), 'n2');
    appendChunkToNode(b.device, b.node, line(0, 1), 'm1');
    // Asset A is shifted +100 in x; asset B is not placed at all.
    a.node.model = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1]);
    const provider = () => buildRayQuerySources([a.node, b.node], ALL);
    assert.strictEqual(provider().length, 3);
    const cam = { fov: Math.PI / 4, canvasHeightPx: 900 };
    const down = { x: 0, y: 0, z: -1 };
    // A's second node, rendered at x = 111: found through the shared rewrite.
    const hitA = queryPointClouds(provider, { origin: { x: 111, y: 0, z: 5 }, direction: down }, cam, 100);
    assert.ok(hitA && Math.abs(hitA.position.x - 111) < 1e-4, `A hit at ${hitA?.position.x}`);
    // B's point at x = 0: B must not inherit A's matrix.
    const hitB = queryPointClouds(provider, { origin: { x: 0, y: 0, z: 5 }, direction: down }, cam, 100);
    assert.ok(hitB && Math.abs(hitB.position.x) < 1e-4, `B hit at ${hitB?.position.x}`);
  });
});
