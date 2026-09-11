/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { BinaryCacheWriter, BinaryCacheReader, toCacheDataStore } from '@ifc-lite/cache';
import { expandAppearanceCorners } from '@ifc-lite/renderer';

test('actual canonical IFC→cache→appearance preview preserves eligibility (#4243)', async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build WASM with pnpm build:wasm for the canonical cache appearance contract'); return;
  }
  const { default: init } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Cache appearance contract'),'2;1');
FILE_NAME('cache.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1ProxyImageTexture00000',$,'Triangle',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.F.,((1,2,3)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
ENDSEC;
END-ISO-10303-21;`);
  const store = await new IfcParser().parseColumnar(source.buffer, { disableWorkerScan: true });
  const processor = new GeometryProcessor();
  try {
    const fresh = await processor.process(source);
    assert.equal(fresh.meshes.length, 1);
    assert.strictEqual(fresh.meshes[0].appearanceSource?.indices, fresh.meshes[0].indices);
    const bytes = await new BinaryCacheWriter().write(toCacheDataStore(store), fresh, source.buffer);
    const cached = await new BinaryCacheReader().read(bytes);
    assert.ok(cached.geometry);
    const restored = cached.geometry.meshes[0];
    const { runAppearancePlanning } = await import('../../workers/appearance.worker.js');
    const plan = await runAppearancePlanning(source, { schema: 'IFC4', sourceRevision: 'cached-model', nextExpressId: 100,
      productIds: [10], imageUri: 'textures/new.png', repeatS: true, repeatT: true,
      mapping: { kind: 'planar', frame: 'item', origin: [0,0,0], axisU: [1,0,0], axisV: [0,1,0], metresPerTile: [1,1] } });
    assert.deepEqual(plan.exclusions, []);
    const item = plan.items[0];
    const bind = (mesh: typeof restored) => expandAppearanceCorners(mesh, item.sourceIndices, item.previewCornerUvs, item.targetIndices, item.targetCornerNormals, item.targetVertexCount);
    const originalPreview = bind(fresh.meshes[0]), restoredPreview = bind(restored);
    assert.deepEqual(restoredPreview.positions, originalPreview.positions);
    assert.deepEqual(restoredPreview.normals, originalPreview.normals);
    assert.deepEqual(restoredPreview.indices, originalPreview.indices);
    assert.deepEqual(restoredPreview.uvs, originalPreview.uvs);
    assert.throws(() => bind({ ...restored, appearanceSource: undefined }), /canonical corner provenance/);
  } finally { processor.dispose(); }
});
