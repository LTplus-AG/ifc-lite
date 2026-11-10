/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { skipUnlessFilesExist } from './host-preconditions.mjs';

const DEFAULTS_MODULE = 'packages/geometry/dist/rhino-export.js';

/** The geometry scene defaults, or the skip reason when this checkout's geometry
 * dist predates them (local only: on CI a missing build is a failure). Imported
 * lazily so a stale dist skips one contract instead of aborting the whole run. */
export async function loadSceneDefaults(rootDir, env = process.env) {
  const reason = skipUnlessFilesExist(rootDir, [DEFAULTS_MODULE], 'pnpm build', env);
  if (reason) return { skip: reason };
  return { defaults: (await import(pathToFileURL(join(rootDir, DEFAULTS_MODULE)).href)).RHINO_SCENE_DEFAULTS };
}

/** Run the Rhino scene contracts against the separate `pkg-rhino` payload on the
 * git-tracked hello-wall sample, or skip when either is absent. `api` is the
 * default engine, which must never carry the scene builder. */
export async function runRhinoExportContracts(api, test, skip, rootDir) {
  test('the default engine does not carry the Rhino scene builder', () => {
    assert.equal(typeof api.exportRhinoScene, 'undefined');
  });
  const wall = join(rootDir, 'apps/landing/samples/hello-wall.ifc');
  const pkg = join(rootDir, 'packages/wasm/pkg-rhino');
  if (!existsSync(wall)) return skip('Rhino export contracts', 'hello-wall.ifc missing');
  if (!existsSync(join(pkg, 'ifc-lite-rhino_bg.wasm'))) return skip('Rhino export contracts', 'pkg-rhino not built (scripts/build-wasm.sh)');
  const rhino = await import(pathToFileURL(join(pkg, 'ifc-lite-rhino.js')).href);
  rhino.initSync({ module: readFileSync(join(pkg, 'ifc-lite-rhino_bg.wasm')) });
  const scene = await loadSceneDefaults(rootDir);
  if (scene.skip) skip('scene defaults match the Rust scene defaults', scene.skip);
  rhinoExportContract(rhino, new Uint8Array(readFileSync(wall)), test, scene.defaults);
}

/** `defaults` is undefined when the defaults contract was skipped. */
function rhinoExportContract(api, wallBytes, test, defaults) {
  if (defaults) test('scene defaults match the Rust scene defaults', () => {
    assert.deepEqual(Object.keys(defaults).sort(), [
      'units', 'coordinates', 'layerScheme', 'instancing', 'properties', 'includeSpaces',
      'normals', 'layerSlicing', 'hidden', 'isolated', 'hiddenTypes',
    ].sort());
    const implicit = api.exportRhinoScene(wallBytes, '{}');
    try {
      const explicit = api.exportRhinoScene(wallBytes, JSON.stringify(defaults));
      try { assert.deepEqual(JSON.parse(implicit.manifest), JSON.parse(explicit.manifest)); }
      finally { explicit.free(); }
    } finally { implicit.free(); }
  });
  test('exportRhinoScene builds the wire scene and rejects invalid options', () => {
    const scene = api.exportRhinoScene(wallBytes, '{}');
    try {
      const manifest = JSON.parse(scene.manifest);
      assert.equal(manifest.format, 'ifc-lite.rhino-scene');
      assert.ok(manifest.objects.length > 0);
      assert.ok(scene.blob instanceof Uint8Array);
    } finally { scene.free(); }
    for (const options of ['{"unknown":true}', '{"units":"yards"}', '{"normals":null}']) {
      assert.throws(() => api.exportRhinoScene(wallBytes, options));
    }
    // invalid options fail before even an empty source can build a scene.
    assert.throws(() => api.exportRhinoScene(new Uint8Array(), '{"units":null}'), /expected value at line|invalid type: null/);
    assert.throws(() => api.exportRhinoScene(wallBytes, '{"isolated":[]}'), /NO_RENDER_GEOMETRY/);
  });
}
