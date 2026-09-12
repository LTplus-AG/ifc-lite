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
#20=IFCSTYLEDITEM(#14,(#21),$);
#21=IFCSURFACESTYLE('Wall material',.BOTH.,(#22));
#22=IFCSURFACESTYLERENDERING(#23,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.2),IFCSPECULARROUGHNESS(0.35),.PHONG.);
#23=IFCCOLOURRGB($,0.4,0.5,0.6);
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
    const material = result.plan.created.find(entity => entity.type === 'IfcSurfaceStyleRendering');
    assert.ok(material, 'finite page export must retain the source rendering leaf');
    assert.deepEqual(material.attributes[6], { typed: { type: 'IFCNORMALISEDRATIOMEASURE', value: 0.2 } });
    assert.deepEqual(material.attributes[7], { typed: { type: 'IFCSPECULARROUGHNESS', value: 0.35 } });
    assert.equal(material.attributes[8], '.PHONG.');
    assert.ok(result.plan.created.some(entity => entity.type === 'IfcSurfaceStyle'
      && Array.isArray(entity.attributes[2]) && entity.attributes[2].includes(`#${material.expressId}`)));
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

test('real transfer WASM envelope supports observed output and an explicit wholly unknown no-plan result #4381', async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build WASM with pnpm build:wasm to run the actual transfer contract'); return;
  }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  const { decodeAtlasOutput } = await import('./page-plan-output');
  await init({ module_or_path: await readFile(wasmUrl) });
  const api = new IfcAPI();
  const points: import('./scan/types').ScanPoint[] = [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[1,1,1],[2,1,0],[1,2,0],[0,1,2]];
  const pairs = points.map((point, i) => ({ id: `p${i}`, sourceObservation: `s${i}`, targetFeature: `t${i}`, source: point, target: point }));
  const registration = { sourceFrame: { assetSha256: 'a'.repeat(64), frameKey: 'controlled-source' }, targetFrame: { assetSha256: createHash('sha256').update(source).digest('hex'), frameKey: 'controlled-target' }, fit: pairs.slice(0,4), heldOut: pairs.slice(4) };
  try {
    const report = JSON.parse(new TextDecoder().decode(api.registerScanCorrespondences(JSON.stringify(registration)))) as import('./scan/types').ScanRegistrationReport;
    const transfer: import('./scan/transfer-types').MeshTransferRequest = {
      schema: 'IFC4', sourceRevision: 'transfer-wasm', nextExpressId: 100, productIds: [10], registration, registrationSha256: report.requestSha256,
      targetFromIfcWorld: { rotation: [[1,0,0],[0,1,0],[0,0,1]], sourceAnchor: [0,0,0], targetAnchor: [0,0,0] },
      source: { kind: 'mesh', meshOrdinal: 0, positions: [[0.2,0.2,0],[0.6,0.2,0],[0.2,0.6,0]], triangles: [[0,1,2]], uvs: [[0,0],[1,0],[0,1]], baseColorFactor: [1,1,1,1], repeatS: false, repeatT: false },
      sourceImage: { width: 1, height: 1, byteOffset: 0, byteLength: 4 }, sourceImages: [], texelsPerMetre: 32,
      maxDistanceMetres: 0.01, minNormalDot: 0.9, ambiguityDistanceMetres: 0.001, maxBehindMetres: 0.005,
    };
    const pixels = new Uint8Array([255,0,0,255]);
    const mesh = transfer.source as import('./scan/transfer-types').TransferSourceMesh;
    const result = decodeAtlasOutput<import('./scan/transfer-types').MeshTransferPlan>(api.planMeshTransfer(source, JSON.stringify(transfer), pixels));
    assert.ok(result.plan && result.transfer.applicable);
    assert.deepEqual(result.transfer.source, { kind: 'mesh', orientation: null, pointCount: null });
    assert.ok(result.transfer.coverage.observedSamples > 0);
    assert.ok(result.transfer.coverage.unknownDistanceSamples > 0);
    assert.equal(result.assets.length, 1);
    assert.equal(result.transfer.registrationSha256, report.requestSha256);
    // A real rotated IFC placement is already part of native world geometry.
    // Unequal viewer rebases add translation only; applying buildingRotation
    // again would miss this registered patch entirely (#4381).
    const rotatedSource = new TextEncoder().encode(new TextDecoder().decode(source)
      .replace('#5=IFCAXIS2PLACEMENT3D(#4,$,$);', '#5=IFCAXIS2PLACEMENT3D(#4,$,#7);\n#7=IFCDIRECTION((0.,1.,0.));'));
    const rotatedRegistration = { ...registration, targetFrame: { ...registration.targetFrame,
      assetSha256: createHash('sha256').update(rotatedSource).digest('hex') } };
    const rotatedReport = JSON.parse(new TextDecoder().decode(api.registerScanCorrespondences(JSON.stringify(rotatedRegistration)))) as import('./scan/types').ScanRegistrationReport;
    const translated: import('./scan/transfer-types').MeshTransferRequest = { ...transfer,
      registration: rotatedRegistration, registrationSha256: rotatedReport.requestSha256,
      targetFromIfcWorld: { ...transfer.targetFromIfcWorld, targetAnchor: [91,-268,183] },
      source: { ...mesh, positions: mesh.positions.map(([x,y,z]): import('./scan/types').ScanPoint => [91-y,-268+x,183+z]) } };
    const rotated = decodeAtlasOutput<import('./scan/transfer-types').MeshTransferPlan>(api.planMeshTransfer(rotatedSource, JSON.stringify(translated), pixels));
    assert.ok(rotated.plan && rotated.transfer.applicable, 'rotated IFC parent plus explicit federation translation still observes the source patch');
    assert.ok(Math.abs(rotated.transfer.coverage.observedAreaEstimateM2 - result.transfer.coverage.observedAreaEstimateM2) < 0.01);
    mesh.positions = mesh.positions.map(([x,y]): import('./scan/types').ScanPoint => [x,y,10]);
    const unknown = decodeAtlasOutput<import('./scan/transfer-types').MeshTransferPlan>(api.planMeshTransfer(source, JSON.stringify(transfer), pixels));
    assert.equal(unknown.plan, null);
    assert.equal(unknown.transfer.applicable, false);
    assert.equal(unknown.transfer.coverage.observedSamples, 0);
    assert.deepEqual(unknown.assets, []);
  } finally { api.free(); }
});
