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
  function run(partitioned, input = bytes) {
    const api = new IfcAPI();
    let result;
    try {
      const pre = api.buildPrePassOnce(input);
      const args = [input, pre.jobs, pre.unitScale, ...pre.rtcOffset, pre.needsShift,
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
          normals: mesh.normals, indices: mesh.indices, origin: mesh.origin,
          localToWorld: mesh.localToWorld };
      } finally {
        mesh.free();
      }
    } finally {
      result?.free();
      api.clearPrePassCache();
      api.free();
    }
  }
  // A real non-planar solid traverses MeshDataJs before the demesher; a
  // level-5 box replacement must not reintroduce the old reversed convention.
  const boxSource = source.replace(/#12=[^;]+;/,
    '#10=IFCCARTESIANPOINT((0.,0.));\n#11=IFCAXIS2PLACEMENT2D(#10,$);\n#12=IFCRECTANGLEPROFILEDEF(.AREA.,$,#11,2.,2.);')
    .replace(/#13=[^;]+;/, '#13=IFCEXTRUDEDAREASOLID(#12,#4,#2,3.);')
    .replace("'Tessellation'", "'SweptSolid'");
  checkSimplifiedWinding(IfcAPI, run(false, new TextEncoder().encode(boxSource)));
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

function checkSimplifiedWinding(IfcAPI, mesh) {
  assert.ok(mesh.localToWorld, 'actual generated mesh must carry placement capture');
  const api = new IfcAPI();
  try {
    for (const level of [1, 5]) {
      const out = api.simplifyMeshes(new Uint32Array([mesh.expressId]), new Uint8Array([level]),
        mesh.positions, mesh.normals, mesh.indices,
        new Uint32Array([mesh.positions.length / 3]), new Uint32Array([mesh.indices.length]),
        mesh.origin, mesh.localToWorld, new Uint8Array([1]), 0, 0, 0, 1, true);
      try {
        assert.deepEqual(Array.from(out.skippedIds), []);
        assert.deepEqual(Array.from(out.elementIds), [mesh.expressId]);
        const indices = out.renderIndices, positions = out.renderPositions, normals = out.renderNormals;
        assert.equal(indices.length, 36, `level ${level}: complete box`);
        assert.deepEqual(out.localIndices, indices, 'proper rotation preserves IFC-local index order');
        for (let i = 0; i < indices.length; i += 3) {
          assert.ok(dotCrossNormal({ indices: indices.subarray(i, i + 3), positions, normals }) > 0,
            `level ${level}: simplified face agrees with outward normals`);
        }
        const local = out.localPositions;
        let volume6 = 0;
        for (let i = 0; i < indices.length; i += 3) {
          const [a, b, c] = Array.from(indices.subarray(i, i + 3), j => local.subarray(j * 3, j * 3 + 3));
          volume6 += a[0] * (b[1] * c[2] - b[2] * c[1])
            + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
        }
        assert.ok(volume6 > 0, `level ${level}: re-exported IFC shell must remain outward`);
      } finally {
        out.free();
      }
    }
  } finally {
    api.free();
  }
}
