/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { calibrateAppearancePlane, type PlaneCalibrationRequest } from './plane-calibration.js';

// Two adjacent IFC surfaces with independently represented shared-edge vertices.
// Their calibrated UV coordinates must agree without per-object normalization.
const pairedSurfaces = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Calibrated adjacent surfaces'),'2;1');
FILE_NAME('paired.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'Left',$,$,$,#12,$,.NOTDEFINED.);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.F.,((1,2,3)),$);
#15=IFCCARTESIANPOINTLIST3D(((1000.,2000.,3.),(1010.,2000.,3.),(1010.,2010.,3.)));
#20=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000b',$,'Right',$,$,$,#22,$,.NOTDEFINED.);
#22=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#23=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#24));
#24=IFCTRIANGULATEDFACESET(#25,$,.F.,((1,2,3)),$);
#25=IFCCARTESIANPOINTLIST3D(((1010.,2000.,3.),(1020.,2000.,3.),(1010.,2010.,3.)));
ENDSEC;
END-ISO-10303-21;`);

test('actual WASM calibrates a rotated page once across object boundaries and raster DPI (#4260)', async t => {
  const artifact = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(artifact); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Run pnpm build:wasm for the actual plane calibration contract'); return;
  }
  const { default: init } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(artifact) });
  const request: PlaneCalibrationRequest = {
    rasterToSource: [0, 0.5, 0.5, 0, 10, 20], rasterSize: [200, 400],
    sourcePoints: [[10, 20], [110, 20]], distanceMetres: 10,
    worldAnchor: [1000, 2000, 3], worldDirection: [1, 0, 0], planeNormal: [0, 0, 1],
  };
  const result = await calibrateAppearancePlane(request);
  assert.equal(result.mapping.frame, 'world');
  assert.deepEqual(result.rasterCorners, [[1000, 2000, 3], [1000, 2010, 3], [1020, 2010, 3], [1020, 2000, 3]]);
  const { runAppearancePlanning } = await import('../../workers/appearance.worker.js');
  const plan = await runAppearancePlanning(pairedSurfaces, { schema: 'IFC4', sourceRevision: 'calibrated-pair',
    nextExpressId: 100, productIds: [10, 20], imageUri: 'textures/page.png', repeatS: false, repeatT: false,
    mapping: result.mapping });
  assert.deepEqual(plan.exclusions, []);
  assert.equal(plan.items.length, 2);
  assert.deepEqual(plan.items[0].texCoords, [[0, 1], [0, 0.5], [1, 0.5]]);
  assert.deepEqual(plan.items[1].texCoords, [[0, 0.5], [0, 0], [1, 0.5]]);
  const higherDpi = await calibrateAppearancePlane({ ...request,
    rasterToSource: [0, 0.25, 0.25, 0, 10, 20], rasterSize: [400, 800] });
  assert.deepEqual(higherDpi, result);
  await assert.rejects(calibrateAppearancePlane({ ...request, distanceMetres: 0 }), /positive measured distance/);
  await assert.rejects(calibrateAppearancePlane({ ...request,
    worldAnchor: [1e16, 0, 0], worldDirection: [1, 1, 0],
    rasterToSource: [1, 0, 0, -1, 0, 1], rasterSize: [1, 1],
    sourcePoints: [[0, 0], [1, 0]], distanceMetres: 1,
  }), /coordinate precision/);
  assert.deepEqual(await calibrateAppearancePlane(request), result, 'rejected calibration leaves later calls usable');
});
