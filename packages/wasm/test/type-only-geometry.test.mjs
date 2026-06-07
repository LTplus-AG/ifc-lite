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
        assert.ok(
          boiler.every((m) => m.geometryClass === 1),
          'a genuinely-orphan type (no occurrence) must be geometryClass=1 so it shows in BOTH ' +
            'Model and Types modes (it is the only geometry the file has)',
        );
      } finally {
        api.free?.();
      }
    });
  }
});

/**
 * Issue #957 follow-up + Model/Types view switch — the LIVE VIEWER path.
 *
 * ArchiCAD/AC20 exports attach a RepresentationMap to a typed product while the
 * OCCURRENCE carries its own direct body geometry (no IfcMappedItem). The type
 * and occurrence are linked only by IfcRelDefinesByType, so the map is referenced
 * by no IfcMappedItem. The viewer path now EMITS the instanced type's geometry
 * tagged geometryClass=2 (vs class 1 for genuinely-orphan annex-E types, class 0
 * for occurrences) so the Model/Types switch can hide it in Model mode (avoiding
 * the duplicate-box-at-MappingOrigin regression) and show it in Types mode.
 */
const INSTANCED_DIRECT_GEOMETRY_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-957 instanced type, direct-geometry occurrence'),'2;1');
FILE_NAME('t.ifc','2026-06-07T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#43=IFCBOILERTYPE('2n5ASfQfT84eP9h$zLLJ4A',$,'Boiler',$,$,$,(#44),$,$,.NOTDEFINED.);
#44=IFCREPRESENTATIONMAP(#45,#46);
#45=IFCAXIS2PLACEMENT3D(#4,$,$);
#46=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#48));
#48=IFCTRIANGULATEDFACESET(#49,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#49=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#100=IFCBOILER('1occurrenceDirect000',$,'Occ',$,$,#101,#102,$,.NOTDEFINED.);
#101=IFCLOCALPLACEMENT($,#5);
#102=IFCPRODUCTDEFINITIONSHAPE($,$,(#103));
#103=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#106));
#106=IFCTRIANGULATEDFACESET(#107,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#107=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(0.,2.,0.),(0.,0.,2.)));
#110=IFCRELDEFINESBYTYPE('3defByTypeLink00000000',$,$,$,(#100),#43);
ENDSEC;
END-ISO-10303-21;
`;

describe('@ifc-lite/wasm instanced-type geometry is tagged for the Model/Types switch (#957 follow-up)', () => {
  it('emits the instanced type as geometryClass=2 and the occurrence as class 0', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
      t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
      return;
    }

    const { initSync, IfcAPI } = await import(wasmJsPath);
    const { parseMeshesViaPrePass } = await import(
      join(rootDir, 'scripts', 'lib', 'mesh-via-prepass.mjs')
    );

    initSync(readFileSync(wasmPath));
    const api = new IfcAPI();
    try {
      const result = parseMeshesViaPrePass(api, INSTANCED_DIRECT_GEOMETRY_IFC);

      const occurrence = [];
      const typeDirect = [];
      for (let i = 0; i < result.length; i++) {
        const m = result.get(i);
        if (!m) continue;
        if (m.expressId === 100) occurrence.push(m);
        if (m.expressId === 43) typeDirect.push(m);
      }

      assert.ok(occurrence.length >= 1, 'the IfcBoiler occurrence #100 (direct geometry) should render');
      assert.ok(
        occurrence.every((m) => m.geometryClass === 0),
        'occurrence meshes must be geometryClass=0 (Model)',
      );
      assert.ok(
        typeDirect.length >= 1,
        'the instanced type #43 geometry is now EMITTED (for the Types view), not suppressed',
      );
      assert.ok(
        typeDirect.every((m) => m.geometryClass === 2),
        'an IfcRelDefinesByType-instanced type must be tagged geometryClass=2 so the viewer ' +
          'hides it in Model mode (no duplicate box) and shows it in Types mode',
      );
    } finally {
      api.free?.();
    }
  });
});
