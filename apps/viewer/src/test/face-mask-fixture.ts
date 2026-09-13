/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { texturedProductSource } from './textured-product-fixture.js';

/**
 * Two occurrences share one mapped two-triangle quad (#4404 face masks): a
 * partial selection needs at least two source triangles. A third product is a
 * unique swept box, the Rust contract fixture's. `movedPlacement` gives the
 * chosen occurrence and the box an ordinary (12.345, 67.891, 0.1) m placement;
 * `resizedBox` widens the box profile from 2 m to 3 m, which changes its
 * evaluated surface.
 */
export function faceMaskProductSource(options: { movedPlacement?: boolean; resizedBox?: boolean } = {}): Uint8Array {
  const placement = options.movedPlacement ? '#62' : '#41';
  const profileWidth = options.resizedBox ? '3.' : '2.';
  return new TextEncoder().encode(new TextDecoder().decode(texturedProductSource).replace('ENDSEC;\nEND-ISO', `
#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.)));
#11=IFCTRIANGULATEDFACESET(#10,$,.F.,((1,2,3),(1,3,4)),$);
#12=IFCCOLOURRGB($,0.8,0.2,0.1);
#13=IFCSURFACESTYLERENDERING(#12,0.,$,$,$,$,$,$,.NOTDEFINED.);
#14=IFCSURFACESTYLE('Original',.BOTH.,(#13));
#15=IFCSTYLEDITEM(#11,(#14),$);
#17=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#11));
#20=IFCREPRESENTATIONMAP(#5,#17);
#21=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);
#22=IFCMAPPEDITEM(#20,#21);
#23=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#22));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'Chosen occurrence',$,$,${placement},#24,$,.NOTDEFINED.);
#33=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#22));
#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#35=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000b',$,'Sibling occurrence',$,$,#41,#34,$,.NOTDEFINED.);
#54=IFCRELCONTAINEDINSPATIALSTRUCTURE('0hhhhhhhhhhhhhhhhhhhhh',$,$,$,(#25,#35,#70),#40);
#60=IFCCARTESIANPOINT((12.345,67.891,0.1));
#61=IFCAXIS2PLACEMENT3D(#60,$,$);
#62=IFCLOCALPLACEMENT($,#61);
#70=IFCBUILDINGELEMENTPROXY('0Swept0000000000000001',$,'Swept box',$,$,${placement},#72,$,.NOTDEFINED.);
#72=IFCPRODUCTDEFINITIONSHAPE($,$,(#73));
#73=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#74));
#74=IFCEXTRUDEDAREASOLID(#75,#5,#77,1.);
#75=IFCRECTANGLEPROFILEDEF(.AREA.,$,#76,${profileWidth},1.);
#76=IFCAXIS2PLACEMENT2D(#78,$);
#77=IFCDIRECTION((0.,0.,1.));
#78=IFCCARTESIANPOINT((0.,0.));
#79=IFCSTYLEDITEM(#74,(#14),$);
ENDSEC;\nEND-ISO`));
}
