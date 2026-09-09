/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import type { AppearanceRequest } from './planner-types.js';

// Original controlled IFC4 fixture: one directly represented triangle, no
// geometric/style authoring mocked. Its existing texture has source bottom-left UVs.
const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Appearance worker contract'),'2;1');
FILE_NAME('appearance.ifc','2026-09-09T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
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
#20=IFCIMAGETEXTURE(.T.,.T.,$,$,$,'old.png');
#21=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));
#22=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#14,#21,$);
ENDSEC;
END-ISO-10303-21;
`);
const request: AppearanceRequest = {
  schema: 'IFC4', sourceRevision: 'wasm-contract', nextExpressId: 100, productIds: [10],
  imageUri: 'appearance/new.png', repeatS: false, repeatT: true,
  mapping: { kind: 'existingUv', scale: [2, 3], offset: [0.25, 0.5], rotationRadians: 0 },
};
test('actual WASM worker function plans source-corner UVs and survives rejected requests (#4243)', async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build the WASM artifact with pnpm build:wasm to run the actual appearance contract'); return;
  }
  const { default: init } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const { runAppearancePlanning } = await import('../../workers/appearance.worker.js');
  const result = await runAppearancePlanning(source, request);
  assert.equal(source.byteLength > 0, true, 'WASM must leave caller storage attached');
  assert.equal(result.sourceRevision, 'wasm-contract');
  assert.equal(result.nextExpressId, 100);
  assert.equal(result.nextAvailableExpressId, 108);
  assert.equal(result.created[0].type, 'IfcImageTexture');
  assert.deepEqual(result.created[0].attributes.slice(0, 2), ['.F.', '.T.']);
  assert.deepEqual(result.removed, [22]);
  assert.deepEqual(result.exclusions, []);
  assert.equal(result.items[0].geometryItemId, 14);
  assert.equal(result.items[0].targetVertexCount, 3);
  assert.deepEqual(result.items[0].texCoords, [[0.25, 0.5], [2.25, 0.5], [0.25, 3.5]]);
  assert.deepEqual(result.items[0].previewCornerUvs, [0.25, 0.5, 2.25, 0.5, 0.25, -2.5]);
  // The IFC +Z triangle normal must arrive in the renderer +Y frame.
  assert.deepEqual(result.items[0].targetCornerNormals.map(v => v === 0 ? 0 : v), [0, 1, 0, 0, 1, 0, 0, 1, 0]);
  await assert.rejects(runAppearancePlanning(source, { ...request, nextExpressId: 20 }), /watermark/);
  assert.equal((await runAppearancePlanning(source, request)).created.length, 8);
});
