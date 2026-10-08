/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Hand-authored IFC invariant: two dated tasks assign two products and one product. */
export const CHART_TASK_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000002',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0Building00000000000003',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#5=IFCBUILDINGSTOREY('0Storey00000000000005',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#6=IFCBUILDINGSTOREY('0Storey00000000000006',$,'Level 2',$,$,$,$,$,.ELEMENT.,3.);
#11=IFCRELAGGREGATES('0Agg000000000000000011',$,$,$,#1,(#2));
#12=IFCRELAGGREGATES('0Agg000000000000000012',$,$,$,#2,(#3));
#13=IFCRELAGGREGATES('0Agg000000000000000013',$,$,$,#3,(#5,#6));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCDIRECTION((0.,0.,1.));
#22=IFCDIRECTION((1.,0.,0.));
#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCLOCALPLACEMENT($,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,1.,1.);
#26=IFCEXTRUDEDAREASOLID(#25,#23,#21,1.);
#27=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#41=IFCWALL('0Wall00000000000000041',$,'Wall A',$,$,#24,#28,$,$);
#42=IFCBEAM('0Beam00000000000000042',$,'Beam B',$,$,#24,#28,$,$);
#43=IFCDOOR('0Door00000000000000043',$,'Door C',$,$,#24,#28,$,$,$,$,$);
#90=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel000000000000000090',$,$,$,(#41,#42,#43),#5);
#100=IFCTASKTIME($,$,$,.WORKTIME.,'P5D','2026-09-07T08:00:00','2026-09-11T17:00:00',$,$,$,$,$,$,.T.,$,$,$,$,$,$);
#101=IFCTASK('0Task00000000000000101',$,'Install walls',$,$,$,$,'NotStarted',$,.F.,$,#100,.CONSTRUCTION.);
#102=IFCTASKTIME($,$,$,.WORKTIME.,'P2D','2026-09-14T08:00:00','2026-09-15T17:00:00',$,$,$,$,$,$,.F.,$,$,$,$,$,$);
#103=IFCTASK('0Task00000000000000103',$,'Hang doors',$,$,$,$,'NotStarted',$,.F.,$,#102,.INSTALLATION.);
#110=IFCRELASSIGNSTOPROCESS('0Asg000000000000000110',$,$,$,(#41,#42),$,#101,$);
#111=IFCRELASSIGNSTOPROCESS('0Asg000000000000000111',$,$,$,(#43),$,#103,$);
ENDSEC;
END-ISO-10303-21;
`;
