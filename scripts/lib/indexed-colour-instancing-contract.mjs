/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EDGE-WASM-5 (#7691): a repeated mapped source painted per triangle by an
 * IfcIndexedColourMap keeps its palette on the browser's don't-bake path.
 *
 * `processGeometryBatchPartitioned` arms the router's don't-bake mode when the
 * pre-pass shipped a mapped-instance plan, so a repeated single-solid source
 * materializes once and the other occurrences ride the IFNS shard. A shard
 * instance carries ONE colour. The native pipeline therefore also arms the
 * #858 split guard, which keeps multi-colour sources flat so the palette split
 * survives; the browser batch never armed it, and every occurrence rendered in
 * one colour.
 *
 * Driven the way the viewer drives it: the streaming pre-pass produces the
 * plan (`prepass-columns.mappedInstancePlan`), the process worker installs it
 * with `setMappedInstancePlan`, and one partitioned batch runs every job. The
 * uniform-palette control proves the fixture does reach the don't-bake path:
 * the same shape with a one-colour map must instance (#1807), or the
 * multi-colour assertion would pass for the wrong reason.
 */

import assert from 'node:assert/strict';

/** `INSTANCE_MIN_OCCURRENCES` in `rust/wasm-bindings/src/api/gpu_meshes/batch_partition.rs`. */
const OCCURRENCES = 8;
const RED = [1, 0, 0];
const BLUE = [0, 0, 1];

function fixture(colourIndex) {
  const lines = [];
  const proxies = [];
  for (let i = 0; i < OCCURRENCES; i++) {
    const base = 100 + i * 10;
    proxies.push(base + 6);
    lines.push(
      `#${base}=IFCMAPPEDITEM(#16,#17);`,
      `#${base + 1}=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',(#${base}));`,
      `#${base + 2}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${base + 1}));`,
      `#${base + 3}=IFCCARTESIANPOINT((${3 * i}.,0.,0.));`,
      `#${base + 4}=IFCAXIS2PLACEMENT3D(#${base + 3},$,$);`,
      `#${base + 5}=IFCLOCALPLACEMENT($,#${base + 4});`,
      `#${base + 6}=IFCBUILDINGELEMENTPROXY('${String(base + 6).padStart(22, '0')}',$,'Proxy',$,$,#${base + 5},#${base + 2},$,$);`,
    );
  }
  const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Indexed-colour instancing witness'),'2;1');
FILE_NAME('indexed-colour-instancing.ifc','2026-10-16T00:00:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCUNITASSIGNMENT((#3));
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#2,$);
#6=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#5),#4);
#8=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#12=IFCTRIANGULATEDFACESET(#8,$,.T.,((1,3,2),(1,2,4),(2,3,4),(3,1,4)),$);
#40=IFCCOLOURRGBLIST(((1.,0.,0.),(0.,0.,1.)));
#41=IFCINDEXEDCOLOURMAP(#12,$,#40,(${colourIndex.join(',')}));
#13=IFCSHAPEREPRESENTATION(#5,'Body','Tessellation',(#12));
#15=IFCAXIS2PLACEMENT3D(#1,$,$);
#16=IFCREPRESENTATIONMAP(#15,#13);
#17=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,$,$);
${lines.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
  return { bytes: new TextEncoder().encode(source), proxies };
}

/** The plan the streaming pre-pass ships to every process worker. */
function streamedPlan(IfcAPI, bytes) {
  const api = new IfcAPI();
  try {
    let plan;
    api.buildPrePassStreaming(bytes, (event) => {
      if (event.type === 'prepass-columns') plan = event.mappedInstancePlan;
    }, 4096);
    assert.ok(plan instanceof Uint32Array, 'the streaming pre-pass emitted no mappedInstancePlan');
    return plan;
  } finally {
    api.clearPrePassCache();
    api.free();
  }
}

function partition(IfcAPI, bytes) {
  const plan = streamedPlan(IfcAPI, bytes);
  const api = new IfcAPI();
  let result;
  try {
    const pre = api.buildPrePassOnce(bytes);
    api.setMappedInstancePlan(plan);
    result = api.processGeometryBatchPartitioned(bytes, pre.jobs, pre.unitScale, ...pre.rtcOffset,
      pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    const flat = new Map();
    const collection = result.takeMeshes();
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        try {
          const colours = flat.get(mesh.expressId) ?? [];
          colours.push({ color: Array.from(mesh.color), triangles: mesh.triangleCount });
          flat.set(mesh.expressId, colours);
        } finally {
          mesh.free();
        }
      }
    } finally {
      collection.free();
    }
    return { plan: Array.from(plan), flat, instances: shardInstanceCount(result.takeShard()) };
  } finally {
    result?.free();
    api.clearPrePassCache();
    api.free();
  }
}

/**
 * `instanceCount` from the IFNS header (8 x u32, little-endian; field 3), the
 * layout `packages/geometry/src/packed-instanced-decoder.ts` documents. An
 * empty batch still ships the 32-byte header, so byte length cannot tell
 * "no instances" apart from "some".
 */
function shardInstanceCount(shard) {
  if (shard.byteLength === 0) return 0;
  assert.ok(shard.byteLength >= 32, `IFNS shard shorter than its header: ${shard.byteLength} bytes`);
  return new DataView(shard.buffer, shard.byteOffset, shard.byteLength).getUint32(12, true);
}

const near = (color, rgb) => rgb.every((v, i) => Math.abs(color[i] - v) < 1e-3);

export function runIndexedColourInstancingContract(IfcAPI, test) {
  console.log('\n📋 EDGE-WASM-5 multi-colour mapped sources keep their palette on the don\'t-bake path');

  test('control: a uniform-palette repeated source instances (the fixture reaches don\'t-bake)', () => {
    const { bytes } = fixture([1, 1, 1, 1]);
    const { plan, flat, instances } = partition(IfcAPI, bytes);
    assert.deepEqual(plan, [16], 'the pre-pass must plan the shared RepresentationMap #16');
    assert.equal(instances, OCCURRENCES,
      `a one-colour source loses nothing as an instance, so all ${OCCURRENCES} occurrences must ride the shard ` +
        `(flat: ${JSON.stringify([...flat])})`);
  });

  test('every occurrence of a multi-colour repeated source renders flat with both palette colours', () => {
    const { bytes, proxies } = fixture([1, 1, 2, 2]);
    const { plan, flat, instances } = partition(IfcAPI, bytes);
    assert.deepEqual(plan, [16], 'the pre-pass must plan the shared RepresentationMap #16');
    assert.equal(instances, 0,
      'a multi-colour source reached the instanced shard, where each occurrence carries one colour');
    for (const id of proxies) {
      const pieces = flat.get(id) ?? [];
      const red = pieces.filter((p) => near(p.color, RED));
      const blue = pieces.filter((p) => near(p.color, BLUE));
      assert.deepEqual(
        [pieces.length, red.length, blue.length, red[0]?.triangles, blue[0]?.triangles],
        [2, 1, 1, 2, 2],
        `#${id}: expected one red and one blue two-triangle piece, got ${JSON.stringify(pieces)}`,
      );
    }
  });
}
