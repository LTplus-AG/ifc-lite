/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test, vi } from 'vitest';
import { readRhino3dm, RhinoReadError, writeRhino3dm } from './index.js';
import type { EncodedRhinoScene, RhinoSceneManifest } from './index.js';
import { discardRhino, loadRhino } from './runtime.js';
import { craft, hollowArchive } from '../test-support/craft.js';

/**
 * The factory under test control: every module it builds is recorded, and while `armed` is set the
 * next module is built unusable. That stands in for the emscripten abort that leaves a module dead
 * and makes the reader drop the shared runtime, which is what hands another caller a module it
 * must not use.
 */
const hooks = vi.hoisted(() => {
  const trap = (): never => { throw new WebAssembly.RuntimeError('Aborted(). Build with -sASSERTIONS for more info.'); };
  return {
    armed: 0,
    modules: [] as unknown[],
    /** Make a module trap on the parse and on a new document: what the reader and the writer reach for first. */
    breakModule(module: unknown) {
      const broken = function (): never { return trap(); };
      broken.fromByteArray = trap;
      (module as { File3dm: unknown }).File3dm = broken;
    },
  };
});
vi.mock('#rhino-factory', async original => {
  const real = await original<{ default: (options: unknown) => Promise<unknown> }>();
  return {
    default: async (options: unknown) => {
      const module = await real.default(options);
      hooks.modules.push(module);
      if (hooks.armed > 0) { hooks.armed--; hooks.breakModule(module); }
      return module;
    },
  };
});

const code = (promise: Promise<unknown>) => promise.then(() => 'resolved', error => error instanceof RhinoReadError ? error.code : error);

/** One triangle, one layer, one material: the smallest scene the writer accepts. */
function scene(): EncodedRhinoScene {
  const blob = new Uint8Array(120), d = new DataView(blob.buffer);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((x, i) => d.setFloat64(i * 8, x, true));
  [0, 0, 1, 0, 0, 1, 0, 0, 1].forEach((x, i) => d.setFloat32(72 + i * 4, x, true));
  [0, 1, 2].forEach((x, i) => d.setUint32(108 + i * 4, x, true));
  const manifest: RhinoSceneManifest = {
    format: 'ifc-lite.rhino-scene', version: 1,
    settings: { unitSystem: 'Meters', metersPerUnit: 1, absoluteTolerance: 0.001, angleToleranceDegrees: 1, earthAnchor: null },
    warnings: [], documentStrings: [],
    layers: [{ name: 'Default', parent: null, color: [0, 0, 0, 255], visible: true, locked: false, userStrings: [] }],
    materials: [{ name: 'Plain', diffuse: [1, 2, 3], transparency: 0 }], groups: [],
    meshes: [{ positions: { offset: 0, count: 9 }, normals: { offset: 72, count: 9 }, indices: { offset: 108, count: 3 } }],
    blocks: [],
    objects: [{ kind: 'mesh', mesh: 0, layer: 0, name: 'Triangle', objectId: 'id', color: [1, 2, 3, 255], material: 0, groups: [], userStrings: [] }],
  };
  return { manifest: JSON.stringify(manifest), blob };
}

// Review finding on PR #9880, deferred to issue #10021.
test('a read that waited through two aborts in a row parses with the module that is current', async () => {
  const small = await craft(c => { c.addMesh(c.box([0, 0, 0], [1, 1, 1])); });
  const shared = await loadRhino();
  const before = hooks.modules.length;
  // Three reads handed one module. The first drops it; the second is handed the replacement, which
  // is built dead as well, and drops that too. One recheck after the load leaves the third read
  // parsing with the second module, so a file that is fine comes back as damage.
  hooks.armed = 1;
  hooks.breakModule(shared);
  const first = readRhino3dm(hollowArchive(33)), second = readRhino3dm(hollowArchive(33)), third = readRhino3dm(small);
  expect(await code(first)).toBe('too-large');
  expect(await code(second)).toBe('too-large');
  expect((await third).meshes).toHaveLength(1);
  // Two replacements: the read reacquired twice, not once.
  expect(hooks.modules.length - before).toBe(2);
  expect(await loadRhino()).not.toBe(shared);
});

// Issue #10021: the writer had the same window, with no recheck at all.
test('a write that waited through an abort runs on the module that is current', async () => {
  const written = scene();
  const shared = await loadRhino();
  const before = hooks.modules.length;
  hooks.breakModule(shared);
  const writing = writeRhino3dm(written);
  // The abort lands while the write is still waiting on the runtime it was handed.
  discardRhino();
  expect((await writing).objectCount).toBe(1);
  expect(hooks.modules.length - before).toBe(1);
  // The replacement is usable: a read of what was written comes back whole.
  expect((await readRhino3dm((await writeRhino3dm(written)).bytes)).meshes).toHaveLength(1);
});
