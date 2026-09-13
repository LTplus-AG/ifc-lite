/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unpackTransfer } from './wasm-mesh-transfer-contract.mjs';

// Controlled 4 mm partition (#4381): front face y=0 facing -Y, back face
// y=0.004 facing +Y. A synthetic control, not a claimed real scan/BIM pair.
export const thinWallIfc = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-4381 thin wall transfer control'),'2;1');
FILE_NAME('thinwall.ifc','2026-09-11T00:00:00',(''),(''),'','','');
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
`;
const THICKNESS = 0.004;
/** Constant UVs at the centre of one pixel of the 3×1 red/blue/yellow image. */
const RED = [1 / 6, 0.5], BLUE = [0.5, 0.5], YELLOW = [5 / 6, 0.5];
export const surfacePixels = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
/** Scanned XZ quad at height `y` over `x` × `0..1`, wound to face -Y or +Y. */
function quad(mesh, y, [x0, x1], facingNegativeY, uv) {
  const a = mesh.positions.length;
  mesh.positions.push([x0, y, 0], [x1, y, 0], [x1, y, 1], [x0, y, 1]);
  mesh.uvs.push(uv, uv, uv, uv);
  const [b, c, d] = [a + 1, a + 2, a + 3];
  mesh.triangles.push(...(facingNegativeY ? [[a, b, c], [a, c, d]] : [[a, c, b], [a, d, c]]));
}
function scan(...quads) {
  const mesh = { kind: 'mesh', meshOrdinal: 0, positions: [], triangles: [], uvs: [], baseColorFactor: [1, 1, 1, 1], repeatS: false, repeatT: false };
  for (const args of quads) quad(mesh, ...args);
  return mesh;
}
export function thinWallRequest(api, source, maxDistanceMetres, maxBehindMetres) {
  const pair = (kind, i, p) => ({ id: `${kind}${i}`, sourceObservation: `${kind}-scan${i}`, targetFeature: `${kind}-ifc${i}`, source: p, target: p });
  const registration = {
    sourceFrame: { assetSha256: 'b'.repeat(64), frameKey: 'controlled-scan' },
    targetFrame: { assetSha256: createHash('sha256').update(thinWallIfc).digest('hex'), frameKey: 'controlled-wall' },
    fit: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]].map((p, i) => pair('fit', i, p)),
    heldOut: [[1, 1, 1], [2, 1, 0], [1, 2, 0], [0, 1, 2]].map((p, i) => pair('check', i, p)),
  };
  const report = JSON.parse(new TextDecoder().decode(api.registerScanCorrespondences(JSON.stringify(registration))));
  return {
    schema: 'IFC4', sourceRevision: 'thin-wall-control', nextExpressId: 100, productIds: [40], registration,
    registrationSha256: report.requestSha256,
    targetFromIfcWorld: { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sourceAnchor: [0, 0, 0], targetAnchor: [0, 0, 0] },
    source, sourceImage: { width: 3, height: 1, byteOffset: 0, byteLength: 12 }, sourceImages: [],
    texelsPerMetre: 64, maxDistanceMetres, minNormalDot: 0.8, ambiguityDistanceMetres: 0.001, maxBehindMetres,
  };
}
function unknownSum(coverage) {
  return coverage.unknownDistanceSamples + coverage.unknownNormalSamples + coverage.unknownAmbiguousSamples + coverage.unknownBehindSamples + coverage.unknownSparseSamples;
}
/** Thin-wall, occlusion and missing-region classification over the real WASM boundary (#4381). */
export function checkMeshTransferSurfacesContract(IfcAPI) {
  const api = new IfcAPI();
  try {
    const run = request => unpackTransfer(api.planMeshTransfer(new TextEncoder().encode(thinWallIfc), JSON.stringify(request), surfacePixels));
    // Both faces scanned 1 mm outside the wall; the back capture stops at x=0.5.
    const twoSided = scan([-0.001, [0, 1], true, RED], [THICKNESS + 0.001, [0, 0.5], false, BLUE]);
    const { metadata } = run(thinWallRequest(api, twoSided, 0.02, 0.005));
    const coverage = metadata.transfer.coverage;
    assert.equal(metadata.transfer.applicable, true);
    assert.equal(metadata.transfer.exclusions.length, 0);
    assert.ok(coverage.observedRasterInteriorTexels > 0);
    assert.ok(coverage.unknownNormalSamples > 0, 'the uncaptured back region faces the opposite capture and stays unknown');
    assert.equal(coverage.unknownDistanceSamples, 0);
    assert.equal(coverage.unknownAmbiguousSamples, 0);
    assert.equal(coverage.unknownBehindSamples, 0);
    assert.equal(coverage.samples, coverage.observedSamples + unknownSum(coverage));
    assert.ok(Math.abs(coverage.observedAreaEstimateM2 + coverage.unknownAreaEstimateM2 - 2) < 1e-9);
    assert.ok(coverage.observedAreaEstimateM2 > 1.4 && coverage.observedAreaEstimateM2 < 1.6, JSON.stringify(coverage));
    // A yellow slab 6 mm in front of a gap in the front capture: its wall-facing
    // side opposes the front face (normal) and lies 10 mm beyond the back face (behind).
    const occluded = scan([-0.001, [0, 0.4], true, RED], [-0.001, [0.6, 1], true, RED],
      [-0.006, [0.4, 0.6], false, YELLOW], [-0.008, [0.4, 0.6], true, YELLOW]);
    const guarded = run(thinWallRequest(api, occluded, 0.02, 0.005)).metadata.transfer.coverage;
    assert.ok(guarded.unknownBehindSamples > 0 && guarded.unknownNormalSamples > 0, JSON.stringify(guarded));
    assert.equal(guarded.unknownDistanceSamples, 0);
    assert.equal(guarded.samples, guarded.observedSamples + unknownSum(guarded));
    // Loosening the behind bound to the distance bound admits the far-side bleed.
    const loose = run(thinWallRequest(api, occluded, 0.02, 0.02)).metadata.transfer.coverage;
    assert.equal(loose.unknownBehindSamples, 0);
    assert.ok(loose.observedSamples > guarded.observedSamples);
    assert.throws(() => run(thinWallRequest(api, occluded, 0.02, 0.03)), /behind/);
    assert.throws(() => run(thinWallRequest(api, occluded, 0.02, -0.001)), /behind/);
    const legacy = thinWallRequest(api, occluded, 0.02, 0.005);
    delete legacy.maxBehindMetres;
    assert.throws(() => run(legacy), /maxBehindMetres/);
  } finally { api.free(); }
}
