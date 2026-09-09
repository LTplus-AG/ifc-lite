/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export const texturedProductSource = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('annotation creation contract'),'2;1');
FILE_NAME('plane.ifc','2026-09-09',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project000000000000000',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCBUILDINGSTOREY('0Storey0000000000000000',$,'Level',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#5);
#42=IFCRELAGGREGATES('0ccccccccccccccccccccc',$,$,$,#50,(#40));
#50=IFCBUILDING('0ddddddddddddddddddddd',$,'Building',$,$,#41,$,$,.ELEMENT.,$,$,$);
#51=IFCSPACE('0eeeeeeeeeeeeeeeeeeeee',$,'Room',$,$,#41,$,$,.ELEMENT.,.INTERNAL.,$);
#52=IFCRELAGGREGATES('0fffffffffffffffffffff',$,$,$,#1,(#50));
#53=IFCRELAGGREGATES('0ggggggggggggggggggggg',$,$,$,#40,(#51));
ENDSEC;
END-ISO-10303-21;`);
export const texturedProductPng = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
