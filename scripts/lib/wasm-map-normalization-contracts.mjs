/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';

const source = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0M7tQ9Jbj1BAeHd7rqnDmP',$,'Project',$,$,$,$,(#10),#4);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCUNITASSIGNMENT((#2));
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#20=IFCLOCALPLACEMENT($,#11);
#41=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,2.);
#42=IFCEXTRUDEDAREASOLID(#41,#11,#43,3.);
#43=IFCDIRECTION((0.,0.,1.));
#44=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));
#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));
#50=IFCWALL('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Wall',$,$,#20,#45,$,.NOTDEFINED.);
#60=IFCPROJECTEDCRS('EPSG:32610',$,$,$,$,$,#3);
#61=IFCMAPCONVERSION(#10,#60,500000.,4200000.,5.,0.6,0.8,0.9996);
ENDSEC;
END-ISO-10303-21;`;

/** Real binding safety: refusal remains atomic and errors release Rust borrows. */
export function runMapNormalizationContracts(api, test) {
  const bytes = text => new TextEncoder().encode(text);
  test('#6587 canonical map plan crosses the real WASM boundary with complete entity IDs', () => {
    const plan = JSON.parse(api.planMapConversionNormalization(bytes(source)));
    assert.deepEqual(plan.warnings, []);
    assert.deepEqual(new Set(plan.replacements.map(patch => patch.expressId)), new Set([50, 45, 61]));
    assert.ok(plan.newEntities.length > 0);
    const ids = new Set(plan.newEntities.map(patch => patch.expressId));
    assert.equal(ids.size, plan.newEntities.length);
    for (const patch of plan.newEntities) assert.ok(patch.line.startsWith(`#${patch.expressId}=`));
    assert.match(plan.replacements.find(patch => patch.expressId === 61).line, /,0\.,0\.,0\.,1\.,0\.,1\.\);$/);
  });
  test('#6587 direct WASM planner refuses unresolved, wrong-type, cyclic and malformed target units atomically', () => {
    for (const invalid of [
      source.replace("FILE_SCHEMA(('IFC4'));", "FILE_SCHEMA(('IFC2X3'));"),
      source.replace("FILE_SCHEMA(('IFC4'));", ''),
      source.replace('$,$,$,#3);', '$,$,$,#999);'),
      source.replace('$,$,$,#3);', '$,$,$,#12);'),
      source.replace('#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', '#3=IFCSIUNIT(*,.LENGTHUNIT.,.BOGUS.,.METRE.)'),
      source.replace('#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', "#3=IFCCONVERSIONBASEDUNIT(#12,.LENGTHUNIT.,'METRE',#100);\n#100=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3)"),
    ]) {
      const plan = JSON.parse(api.planMapConversionNormalization(bytes(invalid)));
      assert.ok(plan.warnings.length > 0, 'authored bad unit must not use tolerant renderer metre fallback');
      assert.deepEqual(plan.replacements, []);
      assert.deepEqual(plan.newEntities, []);
    }
  });
  test('#6587 failed WASM planning releases its borrow so the same handle remains usable', () => {
    const duplicate = source.replace('ENDSEC;\nEND-ISO', '#50=IFCCARTESIANPOINT((1.,2.,3.));\nENDSEC;\nEND-ISO');
    assert.throws(() => api.planMapConversionNormalization(bytes(duplicate)), /duplicate entity #50/);
    assert.deepEqual(JSON.parse(api.planMapConversionNormalization(bytes(source))).warnings, []);
  });
}
