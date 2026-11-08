/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RHINO_SCENE_DEFAULTS } from '../../packages/geometry/dist/rhino-export.js';

/** Run the Rhino scene contracts on the git-tracked hello-wall sample, or skip without it. */
export function runRhinoExportContracts(api, test, skip, rootDir) {
  const wall = join(rootDir, 'apps/landing/samples/hello-wall.ifc');
  if (!existsSync(wall)) return skip('Rhino export contracts', 'hello-wall.ifc missing');
  rhinoExportContract(api, new Uint8Array(readFileSync(wall)), test);
}

function rhinoExportContract(api, wallBytes, test) {
  test('scene defaults match the Rust scene defaults', () => {
    assert.deepEqual(Object.keys(RHINO_SCENE_DEFAULTS).sort(), [
      'units', 'coordinates', 'layerScheme', 'instancing', 'properties', 'includeSpaces',
      'normals', 'layerSlicing', 'hidden', 'isolated', 'hiddenTypes',
    ].sort());
    const implicit = api.exportRhinoScene(wallBytes, '{}');
    try {
      const explicit = api.exportRhinoScene(wallBytes, JSON.stringify(RHINO_SCENE_DEFAULTS));
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
