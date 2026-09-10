/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #4406: planar annotation fills through the real prepass and geometry batch. */
import assert from 'node:assert/strict';

const source = "ISO-10303-21;HEADER;FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');FILE_NAME('fill.ifc','2026-09-10T00:00:00',(''),(''),'IfcOpenShell','IfcOpenShell','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);\n#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);#5=IFCUNITASSIGNMENT((#4));#6=IFCPROJECT('0000000000000000000000',$,'Annotation fill controls',$,$,$,$,(#3),#5);\n#10=IFCCARTESIANPOINT((0.,0.));#11=IFCCARTESIANPOINT((4000.,0.));#12=IFCCARTESIANPOINT((4000.,4000.));#13=IFCCARTESIANPOINT((0.,4000.));\n#14=IFCCARTESIANPOINT((1000.,1000.));#15=IFCCARTESIANPOINT((2000.,1000.));#16=IFCCARTESIANPOINT((2000.,2000.));#17=IFCCARTESIANPOINT((1000.,2000.));\n#20=IFCPOLYLINE((#10,#11,#12,#13,#10));#21=IFCPOLYLINE((#14,#15,#16,#17,#14));#22=IFCANNOTATIONFILLAREA(#20,(#21));\n#23=IFCCOLOURRGB($,0.2,0.6,0.8);#24=IFCFILLAREASTYLE('Cyan fill',(#23),.F.);#25=IFCSTYLEDITEM(#22,(#24),$);\n#30=IFCSHAPEREPRESENTATION(#3,'Annotation','Annotation2D',(#22));#31=IFCPRODUCTDEFINITIONSHAPE($,$,(#30));#32=IFCLOCALPLACEMENT($,#2);\n#40=IFCANNOTATION('0000000000000000000001',$,'Horizontal fill',$,$,#32,#31);\n#41=IFCDIRECTION((0.,1.,0.));#42=IFCCARTESIANPOINT((10000.,20000.,30000.));#43=IFCAXIS2PLACEMENT3D(#42,#41,$);#44=IFCLOCALPLACEMENT($,#43);\n#45=IFCANNOTATION('0000000000000000000002',$,'Vertical fill',$,$,#44,#31);\n#50=IFCSHAPEREPRESENTATION(#3,'FootPrint','Annotation2D',(#22));#51=IFCREPRESENTATIONMAP(#2,#50);#52=IFCDOORTYPE('0000000000000000000003',$,'Footprint only',$,$,$,(#51),$,$,.DOOR.,.SINGLE_SWING_LEFT.,.F.,$);\nENDSEC;END-ISO-10303-21;";

export function checkAnnotationFillContract(IfcAPI) {
  const api = new IfcAPI();
  let result;
  try {
    const bytes = new TextEncoder().encode(source);
    const pre = api.buildPrePassOnce(bytes);
    result = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, ...pre.rtcOffset,
      pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    assert.equal(result.length, 2, 'actual annotations render; type footprint remains absent');
    const ids = [];
    for (let i = 0; i < result.length; i++) {
      const mesh = result.get(i);
      try {
        ids.push(mesh.expressId);
        assert.equal(mesh.triangleCount, 8);
        const color = mesh.color;
        for (const [k, value] of [0.2, 0.6, 0.8, 1].entries())
          assert.ok(Math.abs(color[k] - value) <= 1/255 + 1e-6, 'canonical fill colour survives RGBA8 transport');
        const positions = mesh.positions, indices = mesh.indices, origin = mesh.origin;
        const rtc = pre.needsShift ? [pre.rtcOffset[0],pre.rtcOffset[2],-pre.rtcOffset[1]] : [0,0,0];
        const expected = mesh.expressId === 40 ? [[0,0,-4],[4,0,0]] : [[10,26,-20],[14,30,-20]];
        for (let k=0;k<3;k++) {
          const values=Array.from({length:positions.length/3},(_,i)=>positions[i*3+k]+origin[k]+rtc[k]);
          assert.ok(Math.abs(Math.min(...values)-expected[0][k])<1e-5, 'reconstructed IFC-world Y-up lower bound, including RTC');
          assert.ok(Math.abs(Math.max(...values)-expected[1][k])<1e-5, 'reconstructed IFC-world Y-up upper bound, including RTC');
        }
        let area = 0;
        for (let j = 0; j < indices.length; j += 3) {
          const p = Array.from({length: 3}, (_, k) => Array.from(positions.slice(indices[j+k]*3, indices[j+k]*3+3)));
          const a = p[1].map((v,k) => v-p[0][k]), b = p[2].map((v,k) => v-p[0][k]);
          area += Math.hypot(a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])/2;
        }
        assert.ok(Math.abs(area-15) < 1e-5, 'hole area and millimetre scaling');
      } finally { mesh.free(); }
    }
    assert.deepEqual(ids.sort((a,b)=>a-b), [40,45]);
  } finally {
    result?.free();
    api.clearPrePassCache();
    api.free();
  }
  // A fresh source/index must neither reuse valid paint nor silently default it.
  for (const invalidSource of [
    source.replace('(#23),.F.', '(#23,#23),.F.'),
    source.replace('0.2,0.6,0.8', '1.2,0.6,0.8'),
    source.replace('(#24),$', `(${Array(65).fill('#24').join(',')}),$`),
    source.replace('ENDSEC;END-ISO-10303-21;', '#25=IFCSTYLEDITEM(#20,(#24),$);ENDSEC;END-ISO-10303-21;'),
  ]) {
    const invalidApi = new IfcAPI();
    let invalidMeshes;
    try {
      const bytes = new TextEncoder().encode(invalidSource);
      const pre = invalidApi.buildPrePassOnce(bytes);
      invalidMeshes = invalidApi.processGeometryBatch(bytes, pre.jobs, pre.unitScale, ...pre.rtcOffset,
        pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
      assert.equal(invalidMeshes.length, 0, 'unsupported or aliased paint must refuse, never default');
    } finally {
      invalidMeshes?.free();
      invalidApi.clearPrePassCache();
      invalidApi.free();
    }
  }

}
