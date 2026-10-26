/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0M7tQ9Jbj1BAeHd7rqnDmQ',$,'Project',$,$,$,$,(#10),#4);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCUNITASSIGNMENT((#2));
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#22=IFCLOCALPLACEMENT($,#11);
#41=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,10.,8.);
#42=IFCEXTRUDEDAREASOLID(#41,#11,#43,2.);
#43=IFCDIRECTION((0.,0.,1.));
#44=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));
#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));
#50=IFCSLAB('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Slab',$,$,#22,#45,$,.FLOOR.);
ENDSEC;
END-ISO-10303-21;`);

export function runSectionExportContracts(api, test) {
  const planes = JSON.stringify([{normal:[1,0,0],offset:0},{normal:[0,1,0],offset:0}]);
  test('#7711 real section planner produces closed quarter-slab geometry without changing the source', () => {
    const original = source.slice();
    const plan = JSON.parse(api.planSectionExport(source, planes, true));
    assert.deepEqual(source, original);
    assert.deepEqual(plan.outside, []);
    assert.equal(plan.replacements.length, 1);
    assert.equal(plan.replacements[0].expressId, 50);
    let volume6 = 0;
    for (const part of plan.replacements[0].parts) {
      const vertex = i => part.positions.slice(i*3,i*3+3);
      for (let i = 0; i < part.indices.length; i += 3) {
        const [a,b,c] = part.indices.slice(i,i+3).map(vertex);
        assert.ok([a,b,c].every(p => p[0] <= 1e-8 && p[1] <= 1e-8));
        volume6 += a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]);
      }
    }
    assert.ok(Math.abs(Math.abs(volume6)/6 - 40) < 1e-7);
    assert.deepEqual(JSON.parse(api.planSectionExport(source, planes, false)).replacements, []);
  });
  test('#7711 malformed planes throw and release the same WASM handle for a later successful plan', () => {
    assert.throws(() => api.planSectionExport(source, 'invalid', true));
    assert.throws(() => api.planSectionExport(source, '[{"normal":[0,0,0],"offset":0}]', true));
    assert.equal(JSON.parse(api.planSectionExport(source, planes, true)).replacements.length, 1);
  });
  test('#7711 preflight preserves symbolic subtypes and refuses unmeshed spatial bodies', () => {
    const original = new TextDecoder().decode(source);
    const plan = text => JSON.parse(api.planSectionExport(new TextEncoder().encode(text), planes, true));
    const annotation = original.replace('IFCSLAB(', 'IFCANNOTATION(').replace('#22,#45,$,.FLOOR.', '#22,#45');
    assert.deepEqual(plan(annotation), {replacements:[],outside:[]});
    const opening = original.replace('IFCSLAB(', 'IFCOPENINGSTANDARDCASE(').replace(',.FLOOR.', ',.OPENING.');
    assert.deepEqual(plan(opening), {replacements:[],outside:[]});
    const spatial = original.replace('IFCSLAB(', 'IFCBUILDINGSTOREY(').replace('#22,#45,$,.FLOOR.', '#22,#45,$,.ELEMENT.,0.');
    assert.equal(plan(spatial).replacements.length, 1);
    const unmeshed = spatial.replace('#42=IFCEXTRUDEDAREASOLID(#41,#11,#43,2.);', '#42=IFCBOUNDINGBOX(#12,10.,8.,2.);')
      .replace("'Body','SweptSolid'", "'Box','BoundingBox'");
    assert.throws(() => plan(unmeshed), /cannot safely crop unmeshed IFCBUILDINGSTOREY #50/);
  });
}
