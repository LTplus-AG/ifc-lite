/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #4056: actual WASM flat and partitioned routes preserve outward winding. */
import assert from 'node:assert/strict';
import { Scene } from '../../packages/renderer/dist/scene.js';
import { decodeInstancedShard } from '../../packages/geometry/dist/packed-instanced-decoder.js';

export function checkFlatWindingContract(IfcAPI) {
const source=`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Orientation witness'),'2;1');
FILE_NAME('triangle.ifc','2026-09-07T00:00:00',('Test'),('Test'),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001,#4,$);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCUNITASSIGNMENT((#7));
#9=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#6),#8);
#12=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#13=IFCTRIANGULATEDFACESET(#12,((0.,0.,1.),(0.,0.,1.),(0.,0.,1.)),.F.,((1,2,3)),$);
#14=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#13));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
${Array.from({length:8},(_,i)=>`#${1000+i}=IFCWALL('${String(1000+i).padStart(22,'0')}',$,'Triangle',$,$,#5,#15,$,.NOTDEFINED.);`).join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
  const bytes = new TextEncoder().encode(source);
  function run(partitioned) {
    const api = new IfcAPI();
    let result;
    try {
      const pre = api.buildPrePassOnce(bytes);
      const args = [bytes, pre.jobs, pre.unitScale, ...pre.rtcOffset, pre.needsShift,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors];
      result = partitioned ? api.processGeometryBatchPartitioned(...args)
        : api.processGeometryBatch(...args);
      if (partitioned) {
        assert.equal(result.instancedOccurrences, 8);
        return result.takeShard();
      }
      assert.equal(result.length, 8);
      const mesh = result.get(0);
      assert.ok(mesh);
      try {
        return { expressId: mesh.expressId, positions: mesh.positions,
          normals: mesh.normals, indices: mesh.indices };
      } finally {
        mesh.free();
      }
    } finally {
      result?.free();
      api.clearPrePassCache();
      api.free();
    }
  }
  const flat = run(false);
  const decoded = decodeInstancedShard(run(true));
  // Only upload allocation is stubbed; materialization uses the real Scene.
  const oldUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { VERTEX: 32, INDEX: 16, COPY_DST: 8 };
  const device = {
    createBuffer({ size }) {
      const buffer = new ArrayBuffer(size);
      return { getMappedRange: () => buffer, unmap() {}, destroy() {} };
    },
    queue: { writeBuffer() {} },
    limits: { maxBufferSize: 1 << 30 },
  };
  const scene = new Scene();
  try {
    scene.addInstancedShard(device, decoded);
    const instanced = scene.getInstancedMeshDataPieces(flat.expressId);
    assert.equal(instanced.length, 1);
    for (const [route, mesh] of [['canonical template', decoded.templates[0]],
      ['flat', flat], ['instanced', instanced[0]]]) {
      assert.equal(mesh.indices.length, 3, `${route}: explicit single triangle`);
      assert.ok(dotCrossNormal(mesh) > 0, `${route}: #4056 outward winding must agree with normals`);
    }
  } finally {
    scene.clear();
    if (oldUsage === undefined) delete globalThis.GPUBufferUsage;
    else globalThis.GPUBufferUsage = oldUsage;
  }
}

function dotCrossNormal({ indices, positions: p, normals: n }) {
  const [a, b, c] = indices;
  const u = [0, 1, 2].map(k => p[b * 3 + k] - p[a * 3 + k]);
  const v = [0, 1, 2].map(k => p[c * 3 + k] - p[a * 3 + k]);
  return (u[1] * v[2] - u[2] * v[1]) * n[a * 3]
    + (u[2] * v[0] - u[0] * v[2]) * n[a * 3 + 1]
    + (u[0] * v[1] - u[1] * v[0]) * n[a * 3 + 2];
}
