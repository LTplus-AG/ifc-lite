/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import type { MeshTransferRequest, TransferPointPayload } from './scan/transfer-types';
import type { ScanPoint } from './scan/types';

/** The round-1 4 mm partition: front face y=0 facing -Y, back face y=0.004 facing +Y, styled green. */
const wall = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-4381 thin wall point transfer'),'2;1');
FILE_NAME('thinwall.ifc','2026-09-12',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCWALL('1ThinWall0000000000000',$,'Partition',$,$,#41,#42,$,$);
#41=IFCLOCALPLACEMENT($,#5);
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));
#43=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#44));
#44=IFCTRIANGULATEDFACESET(#45,$,.F.,((1,2,3),(1,3,4),(5,7,6),(5,8,7)),$);
#45=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,0.,1.),(0.,0.,1.),(0.,0.004,0.),(1.,0.004,0.),(1.,0.004,1.),(0.,0.004,1.)));
#46=IFCSTYLEDITEM(#44,(#47),$);
#47=IFCSURFACESTYLE('Plaster',.BOTH.,(#48));
#48=IFCSURFACESTYLERENDERING(#49,0.,$,$,$,$,$,$,.NOTDEFINED.);
#49=IFCCOLOURRGB($,0.,1.,0.);
ENDSEC;
END-ISO-10303-21;
`);
/** XZ sheet of points at height `y` over x0..x1 × 0..1 at 5 mm spacing. */
function sheet(cloud: { positions: number[]; colors: number[] }, y: number, x0: number, x1: number, color: number[]) {
  for (let i = 0; i <= Math.round((x1 - x0) / 0.005); i++) for (let k = 0; k <= 200; k++) { cloud.positions.push(x0 + i * 0.005, y, k * 0.005); cloud.colors.push(...color); }
}
test('real WASM point-cloud transfer keeps thin-wall faces apart, records its orientation source and refuses a mismatched payload (#4381)', async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build WASM with pnpm build:wasm to run the actual point transfer contract'); return;
  }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const { runPointTransfer, runMeshTransfer } = await import('../../workers/appearance.worker.js');
  const api = new IfcAPI();
  const landmarks: ScanPoint[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1], [2, 1, 0], [1, 2, 0], [0, 1, 2]];
  const pairs = landmarks.map((point, i) => ({ id: `p${i}`, sourceObservation: `point:${i}:seen:0`, targetFeature: `t${i}`, source: point, target: point }));
  const registration = { sourceFrame: { assetSha256: 'a'.repeat(64), frameKey: 'pointcloud-native-z-up-metres-v1:' + 'a'.repeat(64) },
    targetFrame: { assetSha256: createHash('sha256').update(wall).digest('hex'), frameKey: 'controlled-target' }, fit: pairs.slice(0, 4), heldOut: pairs.slice(4) };
  try {
    const report = JSON.parse(new TextDecoder().decode(api.registerScanCorrespondences(JSON.stringify(registration)))) as import('./scan/types').ScanRegistrationReport;
    // Both faces scanned 1 mm outside the partition; the back capture stops at x = 0.5.
    const cloud = { positions: [] as number[], colors: [] as number[] };
    sheet(cloud, -0.001, 0, 1, [255, 0, 0]); sheet(cloud, 0.005, 0, 0.5, [0, 0, 255]);
    const payload: TransferPointPayload = { positions: Float64Array.from(cloud.positions), colors: Uint8Array.from(cloud.colors), normals: new Float32Array(0), stations: new Uint32Array(0) };
    const request: MeshTransferRequest = {
      schema: 'IFC4', sourceRevision: 'point-wasm', nextExpressId: 100, productIds: [40], registration, registrationSha256: report.requestSha256,
      targetFromIfcWorld: { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sourceAnchor: [0, 0, 0], targetAnchor: [0, 0, 0] },
      source: { kind: 'points', pointCount: cloud.positions.length / 3, orientation: 'target-referenced', neighborhoodRadiusMetres: 0.03, minNeighbors: 4, maxNeighbors: 32, surfaceBandMetres: 0.003, viewpoints: [] },
      sourceImages: [], texelsPerMetre: 64, maxDistanceMetres: 0.02, minNormalDot: 0.8, ambiguityDistanceMetres: 0.001, maxBehindMetres: 0.01,
    };
    const result = await runPointTransfer(wall, request, new Uint8Array(0), payload);
    assert.ok(result.plan && result.transfer.applicable);
    assert.deepEqual(result.transfer.source, { kind: 'points', orientation: 'target-referenced', pointCount: cloud.positions.length / 3 });
    const coverage = result.transfer.coverage;
    assert.ok(coverage.observedRasterInteriorTexels > 0 && coverage.unknownBehindSamples > 0, JSON.stringify(coverage));
    assert.equal(coverage.unknownDistanceSamples + coverage.unknownSparseSamples + coverage.unknownNormalSamples, 0, JSON.stringify(coverage));
    assert.ok(coverage.observedAreaEstimateM2 > 1.4 && coverage.observedAreaEstimateM2 < 1.6, 'whole front plus half the back, never the far side through the wall');
    assert.equal(result.assets.length, 1);
    assert.equal(result.transfer.registrationSha256, report.requestSha256);
    // The binding refuses a payload whose orientation the request does not declare, and a points request on the mesh entry point.
    await assert.rejects(runPointTransfer(wall, request, new Uint8Array(0), { ...payload, normals: new Float32Array(payload.positions.length) }), /orientation/);
    await assert.rejects(runMeshTransfer(wall, request, new Uint8Array(0)), /binary point payload/);
    await assert.rejects(runPointTransfer(wall, { ...request, source: { ...request.source, pointCount: 3 } as MeshTransferRequest['source'] }, new Uint8Array(0), payload), /point payload/);
  } finally { api.free(); }
});
