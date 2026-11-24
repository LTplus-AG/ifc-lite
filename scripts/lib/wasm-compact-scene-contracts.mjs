/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact geometry from the real wasm encoder to the renderer's Scene.
 *
 * Each fixture is meshed through the load path's calls and handed to a Scene
 * twice: as f32 meshes (the reference), and encoded the way the geometry
 * worker does it (`encodeCompactCollection`, then `adoptCompactMeshes` on the
 * receiving side). Only the GPU device is substituted. The contract:
 *
 * - every mesh the encoder took draws from a compact page: its records carry
 *   exactly the id and colour salt the Scene stamps on the bucket path, the
 *   rule `scene-compact.ts` admits a mesh to a page by. A drift between the
 *   Rust and TypeScript colour salt would send every mesh down the f32 path
 *   without any other sign;
 * - nothing is decoded on the way, and the scene's box matches the reference
 *   within one lattice step;
 * - moving the pages back to buckets decodes each mesh once and leaves the
 *   same box and the same entities.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The runner must start with only the wasm package built, so the renderer and geometry builds this
// contract needs are imported when present and their absence is a named skip.
const DIST = fileURLToPath(new URL('../../packages/', import.meta.url));
const BUILT = ['renderer/dist/scene.js', 'renderer/dist/compact-page-deps.js', 'geometry/dist/compact-geometry.js', 'geometry/dist/compact-shell.js', 'geometry/dist/compact-mesh.js']
  .every((file) => existsSync(join(DIST, file)));
const { Scene } = BUILT ? await import('../../packages/renderer/dist/scene.js') : {};
const { loadCompactPages } = BUILT ? await import('../../packages/renderer/dist/compact-page-deps.js') : {};
const { encodeCompactCollection } = BUILT ? await import('../../packages/geometry/dist/compact-geometry.js') : {};
const { adoptCompactMeshes } = BUILT ? await import('../../packages/geometry/dist/compact-shell.js') : {};
const { compactHydrationStats } = BUILT ? await import('../../packages/geometry/dist/compact-mesh.js') : {};

const STEP = 2 ** -10;
const FIXTURES = [
  { path: 'rust/geometry/tests/fixtures/issue_1910_building_shell_geometry.ifc', committed: true },
  { path: 'tests/models/ara3d/AC20-FZK-Haus.ifc' },
  { path: 'tests/models/ara3d/duplex.ifc' },
];

function fakeGpu() {
  globalThis.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };
  const buffer = (descriptor) => ({ size: descriptor.size, usage: descriptor.usage, destroy() {} });
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: buffer,
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}) }),
    queue: { writeBuffer() {}, submit() {} },
  };
  return { device, pipeline: { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } };
}

/** The fixture's meshes as the geometry worker posts them, `compact` deciding whether it encodes first. */
function meshFixture(api, bytes, compact) {
  const pre = api.buildPrePassOnce(bytes);
  const [rx, ry, rz] = pre.rtcOffset ? Array.from(pre.rtcOffset) : [0, 0, 0];
  const collection = api.processGeometryBatch(
    bytes, pre.jobs, pre.unitScale, rx || 0, ry || 0, rz || 0, pre.needsShift,
    pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
  );
  try {
    const payloads = [];
    const rows = compact ? encodeCompactCollection(collection, 32, payloads) : undefined;
    const meshes = [];
    for (let i = 0; i < collection.length; i++) {
      const m = collection.get(i);
      try {
        const color = m.color;
        meshes.push({
          expressId: m.expressId, modelIndex: 0, positions: m.positions, normals: m.normals, indices: m.indices,
          color: [color[0], color[1], color[2], color[3]],
          ...(m.origin ? { origin: Array.from(m.origin) } : {}),
          ...(rows?.has(i) ? { compact: rows.get(i) } : {}),
        });
      } finally {
        m.free();
      }
    }
    adoptCompactMeshes(meshes, payloads);
    return { meshes, encoded: rows?.size ?? 0 };
  } finally {
    collection.free();
    api.clearPrePassCache?.();
  }
}

/** A scene with the quantized pipelines up, as the viewer's is once its probe resolved. */
function newScene() {
  const scene = new Scene();
  scene.setQuantizedBatches(true);
  return scene;
}

// The page code is a chunk loaded on demand; the contract runner's tests are synchronous, so it is
// fetched here, while this module loads. The reference scenes get f32 meshes and never use it.
if (BUILT) await loadCompactPages();

function sceneOf(meshes) {
  const gpu = fakeGpu();
  const scene = newScene();
  scene.queueMeshes(meshes);
  while (scene.hasQueuedMeshes()) scene.flushPending(gpu.device, gpu.pipeline, 0);
  scene.finalizeStreaming(gpu.device, gpu.pipeline);
  return { scene, gpu };
}

const pagesOf = (scene) => scene.getBatchedMeshes().filter((batch) => batch.indexFormat === 'uint16');
const entities = (batches) => new Set(batches.flatMap((batch) => batch.expressIds));

function assertSameBox(actual, expected, label) {
  for (const corner of ['min', 'max']) {
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(Math.abs(actual[corner][axis] - expected[corner][axis]) <= STEP,
        `${label}: ${corner}.${axis} ${actual[corner][axis]} against ${expected[corner][axis]}`);
    }
  }
}

function checkFixture(IfcAPI, bytes, label) {
  const api = new IfcAPI();
  try {
    const reference = sceneOf(meshFixture(api, bytes, false).meshes).scene;
    const before = compactHydrationStats().meshes;
    const decoded = () => compactHydrationStats().meshes - before;
    const { meshes, encoded } = meshFixture(api, bytes, true);
    assert.ok(encoded > 0, `${label}: the encoder takes meshes`);
    const { scene, gpu } = sceneOf(meshes);

    const paged = pagesOf(scene).reduce((count, page) => count + page.expressIds.length, 0);
    assert.equal(paged, encoded, `${label}: every encoded mesh draws from a page (id and colour salt match the Scene's)`);
    assert.equal(decoded(), 0, `${label}: nothing decoded by the upload`);
    assertSameBox(scene.getBounds(), reference.getBounds(), `${label} pages`);
    assert.deepEqual(entities(scene.getBatchedMeshes()), entities(reference.getBatchedMeshes()), `${label}: the same entities are drawn`);

    assert.equal(scene.demoteCompact(), true);
    scene.rebuildPendingBatches(gpu.device, gpu.pipeline);
    assert.equal(pagesOf(scene).length, 0);
    assert.equal(decoded(), encoded, `${label}: each mesh decoded once on the way back`);
    assertSameBox(scene.getBounds(), reference.getBounds(), `${label} buckets`);
    assert.deepEqual(entities(scene.getBatchedMeshes()), entities(reference.getBatchedMeshes()));
    return { encoded, pages: paged };
  } finally {
    api.free();
  }
}

export function runCompactSceneContracts(IfcAPI, test, skip, rootDir) {
  for (const fixture of FIXTURES) {
    const path = join(rootDir, fixture.path);
    const name = `compact scene: ${fixture.path.split('/').pop()} draws from pages and falls back to buckets`;
    if (!BUILT) {
      skip(name, 'packages/renderer and packages/geometry are not built — run `pnpm build`');
      continue;
    }
    if (!existsSync(path)) {
      assert.ok(!fixture.committed, `${fixture.path} is committed and must exist`);
      skip(name, 'fixture missing — run `pnpm fixtures`');
      continue;
    }
    test(name, () => {
      const result = checkFixture(IfcAPI, readFileSync(path), fixture.path);
      console.log(`     ${result.encoded} encoded, all drawn from pages`);
    });
  }
}
