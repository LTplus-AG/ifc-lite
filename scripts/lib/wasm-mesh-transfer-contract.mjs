/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Controlled direct-TFS target: a 1m triangle, not a claimed real scan/BIM pair.
export const transferIfc = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('mesh transfer invariant #4381'),'2;1');
FILE_NAME('transfer.ifc','2026-09-09T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'Transfer',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1ProxyImageTexture000',$,'Target',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.F.,((1,2,3)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#20=IFCSTYLEDITEM(#14,(#21),$);
#21=IFCSURFACESTYLE($,.BOTH.,(#22));
#22=IFCSURFACESTYLERENDERING(#23,0.,$,$,$,$,$,$,.NOTDEFINED.);
#23=IFCCOLOURRGB($,0.2,0.4,0.6);
ENDSEC;
END-ISO-10303-21;
`;
export function transferFixture(api) {
  const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const registration = {
    sourceFrame: { assetSha256: 'a'.repeat(64), frameKey: 'controlled-source' },
    targetFrame: { assetSha256: createHash('sha256').update(transferIfc).digest('hex'), frameKey: 'controlled-target' },
    fit: points.map((p, i) => ({ id: `p${i}`, sourceObservation: `source-${i}`, targetFeature: `target-${i}`, source: p, target: p })), heldOut: [[1, 1, 1], [2, 1, 0], [1, 2, 0], [0, 1, 2]].map((p,i) => ({ id: `check${i}`, sourceObservation: `check-source-${i}`, targetFeature: `check-target-${i}`, source:p, target:p })),
  };
  const report = JSON.parse(new TextDecoder().decode(api.registerScanCorrespondences(JSON.stringify(registration))));
  return {
    schema: 'IFC4', sourceRevision: 'controlled-transfer', nextExpressId: 100, productIds: [10], registration,
    registrationSha256: report.requestSha256,
    targetFromIfcWorld: { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sourceAnchor: [0, 0, 0], targetAnchor: [0, 0, 0] },
    source: { kind: 'mesh', meshOrdinal: 0, positions: [[0.2, 0.2, 0], [0.6, 0.2, 0], [0.2, 0.6, 0]], triangles: [[0, 1, 2]],
      uvs: [[0, 0], [1, 0], [0, 1]], baseColorFactor: [1, 1, 1, 1], repeatS: false, repeatT: false },
    sourceImage: { width: 2, height: 2, byteOffset: 0, byteLength: 16 }, sourceImages: [],
    texelsPerMetre: 128, maxDistanceMetres: 0.01, minNormalDot: 0.9, ambiguityDistanceMetres: 0.001, maxBehindMetres: 0.005,
  };
}
export const transferPixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
export function unpackTransfer(bytes) {
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'IFPA');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  assert.ok(length > 0 && length <= bytes.length - 8);
  return { metadata: JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))), png: bytes.subarray(8 + length) };
}
export function checkMeshTransferContract(IfcAPI) {
  const api = new IfcAPI();
  try {
    const request = transferFixture(api);
    const run = (r, pixels = transferPixels) => unpackTransfer(api.planMeshTransfer(new TextEncoder().encode(transferIfc), JSON.stringify(r), pixels));
    const { metadata, png } = run(request);
    assert.equal(metadata.plan.items.length, 1);
    assert.equal(metadata.transfer.applicable, true);
    const coverage = metadata.transfer.coverage;
    assert.ok(coverage.observedAreaEstimateM2 > 0.075 && coverage.observedAreaEstimateM2 < 0.11);
    assert.ok(coverage.unknownDistanceSamples > 0);
    assert.equal(coverage.samples, coverage.centroidSamples + coverage.rasterInteriorTexels);
    assert.equal(coverage.observedSamples, coverage.observedCentroidSamples + coverage.observedRasterInteriorTexels);
    assert.ok(coverage.observedRasterInteriorTexels > 0);
    assert.ok(Math.abs(coverage.observedAreaEstimateM2 + coverage.unknownAreaEstimateM2 - 0.5) < 1e-12);
    assert.equal(coverage.samples, coverage.observedSamples + coverage.unknownDistanceSamples + coverage.unknownNormalSamples + coverage.unknownAmbiguousSamples + coverage.unknownBehindSamples + coverage.unknownSparseSamples);
    assert.deepEqual(metadata.transfer.source, { kind: 'mesh', orientation: null, pointCount: null });
    assert.equal(metadata.assets.length, 1);
    assert.equal(metadata.assets[0].byteLength, png.length);
    assert.equal(metadata.assets[0].imageUri, `textures/${createHash('sha256').update(png).digest('hex')}.png`);
    // A tiny source patch observes the centroid but misses every sparse pixel center.
    const sparse = structuredClone(request), c = 1 / 3;
    sparse.source.positions = [[c-.002,c-.002,0],[c+.004,c-.002,0],[c-.002,c+.004,0]];
    sparse.maxDistanceMetres = .00001; sparse.ambiguityDistanceMetres = 0; sparse.maxBehindMetres = 0; sparse.texelsPerMetre = 1;
    const noPixels = run(sparse);
    assert.equal(noPixels.metadata.transfer.coverage.observedCentroidSamples, 1);
    assert.equal(noPixels.metadata.transfer.coverage.observedRasterInteriorTexels, 0);
    assert.equal(noPixels.metadata.transfer.applicable, false);
    assert.equal(noPixels.metadata.plan, null); assert.equal(noPixels.png.length, 0);
    assert.ok(noPixels.metadata.transfer.diagnostics.some(message => message.includes('No observed interior raster texels')));
    const dense = run({...sparse, texelsPerMetre: 512});
    assert.ok(dense.metadata.transfer.coverage.observedRasterInteriorTexels > 0);
    assert.equal(dense.metadata.transfer.applicable, true); assert.ok(dense.png.length > 0);
    const unsupported = run({ ...request, productIds: [1] }).metadata;
    assert.equal(unsupported.plan, null); assert.equal(unsupported.transfer.exclusions[0].productId, 1);
    const insufficient = structuredClone(request); insufficient.registration.heldOut = [];
    insufficient.registrationSha256 = JSON.parse(new TextDecoder().decode(api.registerScanCorrespondences(JSON.stringify(insufficient.registration)))).requestSha256;
    const unapproved = run(insufficient).metadata;
    assert.ok(unapproved.transfer.coverage.observedSamples > 0);
    assert.equal(unapproved.plan, null); assert.equal(unapproved.transfer.applicable, false);
    assert.equal(unapproved.transfer.registration.heldOut.rmsMetres, null);
    assert.ok(!unapproved.transfer.diagnostics.some(message => message.includes("No observed target samples")));
    const moved = structuredClone(request); moved.targetFromIfcWorld.targetAnchor[0] = 10;
    const unknown = run(moved);
    assert.equal(unknown.metadata.plan, null); assert.equal(unknown.png.length, 0);
    assert.equal(unknown.metadata.transfer.applicable, false);
    assert.notEqual(unknown.metadata.transfer.preparedSha256, metadata.transfer.preparedSha256);
    const changed = transferPixels.slice(); changed[0] = 128;
    assert.notEqual(run(request, changed).metadata.transfer.preparedSha256, metadata.transfer.preparedSha256);
    assert.throws(() => run({ ...request, registrationSha256: '0'.repeat(64) }), /digest/);
    assert.throws(() => run({ ...request, undocumented: true }), /unknown field/);
    assert.throws(() => run({ ...request, source: { ...request.source, kind: 'points' } }), /unknown field|missing field/);
    const legacy = { ...request, sourceMesh: request.source }; delete legacy.source;
    assert.throws(() => run(legacy), /unknown field|missing field/);
    const reversed = structuredClone(request); reversed.source.triangles = [[0, 2, 1]];
    assert.ok(run(reversed).metadata.transfer.coverage.unknownNormalSamples > 0);
  } finally { api.free(); }
}
