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

// #1781 — IfcImageTexture (external image reference) on the SAME viewer path:
// the mesh must carry per-vertex UVs plus `textureId`/`textureUrl` (no pixels;
// the browser resolves the URL against the .ifcZIP sibling images). The
// fixture mirrors the SketchUp IFC Manager shape: occurrence-level
// IfcTriangulatedFaceSet, IfcIndexedTriangleTextureMap with `$` TexCoordIndex.
const IMAGE_TEXTURE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-1781 image texture fixture'),'2;1');
FILE_NAME('imgtex.ifc','2026-07-17T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1ProxyImageTexture000',$,'Textured',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#20=IFCIMAGETEXTURE(.T.,.F.,$,$,$,'glTF_Embedded_Texture1.jpg');
#21=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.),(1.,1.)));
#22=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#14,#21,$);
#23=IFCSTYLEDITEM(#14,(#24),$);
#24=IFCSURFACESTYLE('Wood',.BOTH.,(#25,#26));
#25=IFCSURFACESTYLERENDERING(#27,0.,$,$,$,$,$,$,.NOTDEFINED.);
#26=IFCSURFACESTYLEWITHTEXTURES((#20));
#27=IFCCOLOURRGB($,0.5,0.4,0.3);
ENDSEC;
END-ISO-10303-21;
`;

describe('@ifc-lite/wasm external image texture refs (#1781)', () => {
  it('carries textureId + textureUrl + UVs for an occurrence face set', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
      t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh`');
      return;
    }
    const { initSync, IfcAPI } = await import(wasmJsPath);
    initSync(readFileSync(wasmPath));
    const api = new IfcAPI();
    try {
      // `col` stays nullable and is freed in finally, so a mid-call throw
      // still releases the wasm handles.
      let col = null;
      try {
        const bytes = new TextEncoder().encode(IMAGE_TEXTURE_IFC);
        const pre = api.buildPrePassOnce(bytes);
        col = api.processGeometryBatch(
          bytes, pre.jobs, pre.unitScale,
          pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
          pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
        );
        let found = null;
        for (let i = 0; i < col.length; i++) {
          const m = col.get(i);
          try {
            if (m && m.expressId === 10 && m.textureUrl) {
              found = {
                textureId: m.textureId,
                textureUrl: m.textureUrl,
                repeatS: m.textureRepeatS,
                repeatT: m.textureRepeatT,
                hasTexture: m.hasTexture,
                uvsLen: m.uvs.length,
                verts: m.vertexCount,
              };
            }
          } finally {
            m.free();
          }
        }
        assert.ok(found, 'proxy #10 should carry an image texture reference');
        assert.equal(found.textureId, 20, 'textureId = IfcImageTexture express id');
        assert.equal(found.textureUrl, 'glTF_Embedded_Texture1.jpg', 'URLReference verbatim');
        assert.equal(found.repeatS, true, 'RepeatS .T.');
        assert.equal(found.repeatT, false, 'RepeatT .F.');
        assert.equal(found.hasTexture, false, 'image refs ship NO decoded pixels');
        assert.equal(found.uvsLen, found.verts * 2, 'UVs are 1:1 with vertices');
      } finally {
        col?.free();
        if (api.clearPrePassCache) api.clearPrePassCache();
      }
    } finally {
      api.free?.();
    }
  });
});
