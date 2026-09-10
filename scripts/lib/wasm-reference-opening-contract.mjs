/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { transferIfc } from './wasm-mesh-transfer-contract.mjs';

const source=transferIfc.replace('((1,2,3))','((1,3,2),(1,4,3),(5,6,7),(5,7,8),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,4,8),(3,8,7),(4,1,5),(4,5,8))')
  .replace('((0.,0.,0.),(1.,0.,0.),(0.,1.,0.))','((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.),(0.,0.,1.),(1.,0.,1.),(1.,1.,1.),(0.,1.,1.))')
  .replace('$,.F.,((1,3,2)','$,.T.,((1,3,2)')
  .replace('(#22));','(#22,#32));')
  .replace('ENDSEC;\nEND-ISO-10303-21;', `
#30=IFCIMAGETEXTURE(.T.,.F.,$,$,$,'textures/rock.png');
#31=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(1.,1.),(0.,1.),(0.,0.),(1.,0.),(1.,1.),(0.,1.)));
#32=IFCSURFACESTYLEWITHTEXTURES((#30));
#33=IFCINDEXEDTRIANGLETEXTUREMAP((#30),#14,#31,$);
#80=IFCOPENINGELEMENT('0000000000000000000003',$,$,$,$,#11,#81,$,.OPENING.);
#81=IFCPRODUCTDEFINITIONSHAPE($,$,(#82));
#82=IFCSHAPEREPRESENTATION(#2,'Reference','CSG',(#84));
#83=IFCRELVOIDSELEMENT('0000000000000000000004',$,$,$,#10,#80);
#84=IFCBLOCK(#5,0.2,0.2,0.2);
ENDSEC;END-ISO-10303-21;`);

export function checkReferenceOpeningContract(IfcAPI) {
  const host=(text)=> {
    const api=new IfcAPI();let collection;
    try {
      const bytes=new TextEncoder().encode(text), pre=api.buildPrePassOnce(bytes);
      collection=api.processGeometryBatch(bytes,pre.jobs,pre.unitScale,...pre.rtcOffset,pre.needsShift,
        pre.voidKeys,pre.voidCounts,pre.voidValues,pre.styleIds,pre.styleColors);
      let result;
      for(let i=0;i<collection.length;i++) {
        const mesh=collection.get(i);
        try {
          if(mesh.expressId===10) result={positions:Array.from(mesh.positions),indices:Array.from(mesh.indices),
            normals:Array.from(mesh.normals),origin:Array.from(mesh.origin),uvs:Array.from(mesh.uvs),
            textureUrl:mesh.textureUrl,repeatS:mesh.textureRepeatS,repeatT:mesh.textureRepeatT};
        } finally {mesh.free();}
      }
      assert.ok(result,'host is present');return result;
    } finally {collection?.free();api.clearPrePassCache();api.free();}
  };
  const control=host(source.replace("#83=IFCRELVOIDSELEMENT('0000000000000000000004',$,$,$,#10,#80);",''));
  assert.equal(control.textureUrl,'textures/rock.png');assert.ok(control.uvs.length>0);
  assert.deepEqual(host(source),control,'Reference relationship preserves exact canonical host texture binding');
  const body=host(source.replace("'Reference'","'Body'"));
  const mixed=host(source.replace('(#82));','(#82,#85));').replace('#83=',"#85=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#84));\n#83="));
  assert.deepEqual(body,mixed,'mixed Body/Reference retains the same actual cut');
  assert.notEqual(body.indices.length,control.indices.length,'Body still subtracts');
}
