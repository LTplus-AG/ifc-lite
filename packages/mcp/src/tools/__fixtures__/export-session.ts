/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0PROJ0000000000000000X',$,'Project',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCLOCALPLACEMENT($,#21);
#41=IFCBUILDINGSTOREY('0STOREY00000000000000X',$,'Level 1',$,$,#40,$,$,.ELEMENT.,0.);
#42=IFCRELAGGREGATES('0AGGR0000000000000000X',$,$,$,#1,(#41));
#43=IFCRELCONTAINEDINSPATIALSTRUCTURE('0CONT0000000000000000X',$,$,$,(#72),#41);
#72=IFCWALL('0WALL00000000000000000',$,'Existing wall',$,$,#40,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;
export const source = new TextEncoder().encode(MODEL);
