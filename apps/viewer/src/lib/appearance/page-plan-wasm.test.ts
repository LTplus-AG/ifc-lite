/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { decodePagePlan } from './page-plan-output.js';
import type { PageAppearanceRequest } from './planner-types.js';
const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('finite page worker contract'),'2;1');
FILE_NAME('page.ifc','2026-09-09',(''),(''),'','','');
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
ENDSEC;
END-ISO-10303-21;`);
const request: PageAppearanceRequest = {
  appearance: { schema: 'IFC4', sourceRevision: 'page-wasm', nextExpressId: 100,
    productIds: [10], imageUri: 'appearance/page.png', repeatS: false, repeatT: false,
    mapping: { kind: 'planar', frame: 'world', origin: [0.2, 0.2, 0], axisU: [1, 0, 0], axisV: [0, 1, 0], metresPerTile: [0.4, 0.4] } },
  page: { width: 1, height: 1, byteOffset: 0, byteLength: 4 }, sourceImages: [], texelsPerMetre: 64,
};
test('real WASM finite-page output binds PNG atlas assets and rejects corrupt binary envelopes (#4260)', async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build WASM with pnpm build:wasm to run the actual page contract'); return;
  }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const rgba = new Uint8Array([255, 0, 0, 255]), api = new IfcAPI();
  try {
    const binary = api.planPageAppearance(source, JSON.stringify(request), rgba);
    const result = decodePagePlan(binary);
    assert.equal(result.plan.sourceRevision, 'page-wasm');
    assert.equal(result.plan.nextExpressId, 100);
    assert.deepEqual(result.plan.exclusions, []);
    assert.equal(result.itemImages.length, 1);
    assert.equal(result.assets.length, 1);
    const asset = result.assets[0];
    assert.equal(asset.imageUri, result.itemImages[0].imageUri);
    assert.equal(asset.imageUri, `textures/${createHash('sha256').update(asset.png).digest('hex')}.png`);
    assert.ok(result.plan.created.some(entity => entity.type === 'IfcImageTexture' && entity.attributes[5] === asset.imageUri));
    assert.deepEqual([...asset.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const header = new DataView(asset.png.buffer, asset.png.byteOffset, asset.png.byteLength);
    assert.equal(header.getUint32(16), asset.width); assert.equal(header.getUint32(20), asset.height);
    assert.notEqual(asset.png.buffer, binary.buffer, 'one retained atlas must not pin every other asset and JSON');
    assert.throws(() => decodePagePlan(binary.subarray(0, binary.length - 1)), /range/);
    const trailing = new Uint8Array(binary.length + 1); trailing.set(binary);
    assert.throws(() => decodePagePlan(trailing), /trailing/);
    const invalid = binary.slice(); new DataView(invalid.buffer).setUint32(4, 0xffffffff, true);
    assert.throws(() => decodePagePlan(invalid), /metadata length/);
  } finally { api.free(); }
  const { runPageAppearancePlanning } = await import('../../workers/appearance.worker.js');
  await assert.rejects(runPageAppearancePlanning(source, { ...request, texelsPerMetre: 1e9 }, rgba), /budget/);
  assert.equal((await runPageAppearancePlanning(source, request, rgba)).assets.length, 1);
  assert.equal(rgba.byteLength, 4); assert.ok(source.byteLength > 0);
});
