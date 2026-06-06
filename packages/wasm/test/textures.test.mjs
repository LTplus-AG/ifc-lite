/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #961 — surface textures reach the LIVE VIEWER path. The browser renders
 * through `buildPrePassOnce` + `processGeometryBatch`; this test drives that
 * exact path and asserts the boiler mesh carries the Rust-decoded RGBA texture
 * + per-vertex UVs (the renderer then uploads `textureRgba` to a GPU texture).
 *
 * IfcBlobTexture (PNG, decoded in Rust via the `png` crate) and IfcPixelTexture
 * (raw pixel literals) both resolve to RGBA8 with UVs 1:1 with positions.
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
const annexDir = join(rootDir, 'tests', 'models', 'buildingsmart', 'annex_e', 'tessellated-shape-with-style');

const BOILER_TYPE_ID = 43;

function texturedBoiler(api, content) {
  const bytes = new TextEncoder().encode(content);
  const pre = api.buildPrePassOnce(bytes);
  // Free every wasm handle (each MeshDataJs + the MeshCollection) + the prepass
  // cache deterministically, even if an assertion-side error unwinds mid-loop.
  const col = api.processGeometryBatch(
    bytes, pre.jobs, pre.unitScale,
    pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
    pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
  );
  try {
    let found = null;
    for (let i = 0; i < col.length; i++) {
      const m = col.get(i);
      try {
        if (m && m.expressId === BOILER_TYPE_ID && m.hasTexture) {
          found = {
            tris: m.triangleCount,
            uvsLen: m.uvs.length,
            verts: m.vertexCount,
            width: m.textureWidth,
            height: m.textureHeight,
            rgbaLen: m.textureRgba.length,
          };
        }
      } finally {
        m.free();
      }
    }
    return found;
  } finally {
    col.free();
    if (api.clearPrePassCache) api.clearPrePassCache();
  }
}

describe('@ifc-lite/wasm surface textures on the viewer path (#961)', () => {
  for (const name of ['tessellation-with-blob-texture.ifc', 'tessellation-with-pixel-texture.ifc']) {
    it(`decodes + attaches a texture for ${name}`, async (t) => {
      if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
        t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh`');
        return;
      }
      const fixturePath = join(annexDir, name);
      if (!existsSync(fixturePath)) {
        t.skip('fixture missing — run `pnpm fixtures`');
        return;
      }
      const { initSync, IfcAPI } = await import(wasmJsPath);
      initSync(readFileSync(wasmPath));
      const api = new IfcAPI();
      try {
        const boiler = texturedBoiler(api, readFileSync(fixturePath, 'utf8'));
        assert.ok(boiler, `boiler #${BOILER_TYPE_ID} should carry a texture`);
        assert.ok(boiler.width > 0 && boiler.height > 0, 'texture has size');
        assert.equal(boiler.rgbaLen, boiler.width * boiler.height * 4, 'RGBA8 buffer is w*h*4');
        assert.equal(boiler.uvsLen, boiler.verts * 2, 'UVs are 1:1 with vertices (u,v per vertex)');
      } finally {
        api.free?.();
      }
    });
  }
});
