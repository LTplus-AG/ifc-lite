/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #4694: native and actual-WASM style walks share bare-reference tolerance. */
import assert from 'node:assert/strict';
import { parseMeshesViaPrePass } from './mesh-via-prepass.mjs';

const source = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('bare.ifc','2026-09-13T00:00:00',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1ProxyBareStylesRef01',$,'Proxy',$,$,#11,#12,$,$);#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#20=IFCSURFACESTYLE('Red',.BOTH.,(#21));#21=IFCSURFACESTYLESHADING(#22,$);#22=IFCCOLOURRGB($,1.,0.,0.);
#30=IFCSTYLEDITEM(#14,(#20),$);ENDSEC;END-ISO-10303-21;`;

export function checkBareStyleReferenceContract(IfcAPI) {
  const variants = [
    ['list control', source],
    ['StyledItem.Styles', source.replace('#14,(#20),$', '#14,#20,$')],
    ['SurfaceStyle.Styles', source.replace(".BOTH.,(#21)", '.BOTH.,#21')],
  ];
  const api = new IfcAPI();
  try {
    for (const [label, content] of variants) {
      const meshes = parseMeshesViaPrePass(api, content);
      assert.equal(meshes.length, 1, `${label}: the proxy must mesh`);
      const color = meshes.get(0).color;
      for (const [channel, expected] of [1, 0, 0, 1].entries()) {
        assert.ok(Math.abs(color[channel] - expected) <= 1 / 255 + 1e-6,
          `${label}: authored red must cross the real WASM boundary; got ${Array.from(color)}`);
      }
    }
  } finally {
    api.clearPrePassCache();
    api.free();
  }
}
