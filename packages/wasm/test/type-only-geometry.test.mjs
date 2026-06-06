/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #957 regression guard — the LIVE VIEWER path.
 *
 * The browser viewer renders through `buildPrePassOnce` + `processGeometryBatch`
 * (the path `parseMeshesViaPrePass` drives). buildingSMART annex-E
 * "tessellated shape with style" files attach their geometry to an
 * `IfcBoilerType` via `RepresentationMaps` with no occurrence — the product-only
 * job enumeration produced zero meshes, so the model rendered empty. The
 * orphan-RepresentationMap pass must now make the boiler visible (flat white;
 * texture fidelity is a separate follow-up).
 *
 * A rust `process_geometry` test cannot catch a regression on THIS path — the
 * wasm prepass + processGeometryBatch enumerate jobs separately.
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rootDir = join(packageDir, '..', '..');
const wasmPath = join(packageDir, 'pkg', 'ifc-lite_bg.wasm');
const wasmJsPath = join(packageDir, 'pkg', 'ifc-lite.js');
const annexDir = join(
  rootDir,
  'tests',
  'models',
  'buildingsmart',
  'annex_e',
  'tessellated-shape-with-style',
);

const BOILER_TYPE_ID = 43;
const WHITE = [1.0, 1.0, 1.0];

function approxColor(c, target) {
  return target.every((v, i) => Math.abs(c[i] - v) < 1e-3);
}

describe('@ifc-lite/wasm type-only IfcRepresentationMap geometry (#957)', () => {
  for (const name of [
    'tessellation-with-blob-texture.ifc',
    'tessellation-with-image-texture.ifc',
    'tessellation-with-pixel-texture.ifc',
  ]) {
    it(`renders type-only geometry for ${name} on the processGeometryBatch path`, async (t) => {
      if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
        t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
        return;
      }
      const fixturePath = join(annexDir, name);
      if (!existsSync(fixturePath)) {
        t.skip('fixture missing — run `pnpm fixtures` first');
        return;
      }

      const { initSync, IfcAPI } = await import(wasmJsPath);
      const { parseMeshesViaPrePass } = await import(
        join(rootDir, 'scripts', 'lib', 'mesh-via-prepass.mjs')
      );

      initSync(readFileSync(wasmPath));
      const api = new IfcAPI();
      // `parseMeshesViaPrePass` frees its own wasm handles (each MeshDataJs +
      // the MeshCollection) internally and calls clearPrePassCache, returning a
      // plain JS facade — so only the IfcAPI handle needs freeing here.
      try {
        const content = readFileSync(fixturePath, 'utf8');
        const result = parseMeshesViaPrePass(api, content);

        const boiler = [];
        for (let i = 0; i < result.length; i++) {
          const m = result.get(i);
          if (m && m.expressId === BOILER_TYPE_ID) boiler.push(m);
        }

        assert.ok(
          boiler.length >= 1,
          `expected the IfcBoilerType #${BOILER_TYPE_ID} type-only geometry to render; got 0 meshes`,
        );
        const totalTris = boiler.reduce((n, m) => n + m.triangleCount, 0);
        assert.equal(totalTris, 64, `boiler should produce 64 triangles, got ${totalTris}`);
        assert.ok(
          boiler.every((m) => approxColor(m.color, WHITE)),
          'type geometry should inherit the authored white IfcSurfaceStyle',
        );
      } finally {
        api.free?.();
      }
    });
  }
});
