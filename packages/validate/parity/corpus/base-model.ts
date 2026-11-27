/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A minimal, schema-valid IFC4 building covering the authoring subset:
 * project/site/building/storey/space, walls with an opening filled by a door
 * and a window, a slab, a grid, placements, swept-solid geometry, materials,
 * a wall type, a property set and quantities. Each broken corpus file is this
 * model with exactly one defect.
 */

export type Records = Map<number, string>;

let guidCounter = 0;
const GUID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

export function guid(): string {
  let n = ++guidCounter;
  let tail = '';
  while (n > 0) {
    tail = GUID_ALPHABET[n % 64] + tail;
    n = Math.floor(n / 64);
  }
  return `'2${tail.padStart(21, 'x')}'`;
}

export function baseRecords(): Records {
  guidCounter = 0;
  const g = guid;
  const lines: Array<[number, string]> = [
    [1, "IFCPERSON($,'Doe','Jane',$,$,$,$,$)"],
    [2, "IFCORGANIZATION($,'Example Org',$,$,$)"],
    [3, 'IFCPERSONANDORGANIZATION(#1,#2,$)'],
    [4, "IFCAPPLICATION(#2,'1.0','ifc-lite corpus','ifc-lite-corpus')"],
    [5, 'IFCOWNERHISTORY(#3,#4,$,.NOCHANGE.,$,$,$,1700000000)'],
    [6, 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'],
    [7, 'IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'],
    [8, 'IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'],
    [9, 'IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)'],
    [10, 'IFCUNITASSIGNMENT((#6,#7,#8,#9))'],
    [11, 'IFCCARTESIANPOINT((0.,0.,0.))'],
    [12, 'IFCDIRECTION((0.,0.,1.))'],
    [13, 'IFCDIRECTION((1.,0.,0.))'],
    [14, 'IFCAXIS2PLACEMENT3D(#11,#12,#13)'],
    [15, "IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#14,$)"],
    [16, "IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#15,$,.MODEL_VIEW.,$)"],
    [17, "IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,#15,$,.GRAPH_VIEW.,$)"],
    [20, `IFCPROJECT(${g()},#5,'Project',$,$,$,$,(#15),#10)`],
    [21, 'IFCLOCALPLACEMENT($,#14)'],
    [22, `IFCSITE(${g()},#5,'Site',$,$,#21,$,$,.ELEMENT.,$,$,$,$,$)`],
    [23, 'IFCLOCALPLACEMENT(#21,#14)'],
    [24, `IFCBUILDING(${g()},#5,'Building',$,$,#23,$,$,.ELEMENT.,$,$,$)`],
    [25, 'IFCLOCALPLACEMENT(#23,#14)'],
    [26, `IFCBUILDINGSTOREY(${g()},#5,'Level 0',$,$,#25,$,$,.ELEMENT.,0.)`],
    [27, `IFCRELAGGREGATES(${g()},#5,$,$,#20,(#22))`],
    [28, `IFCRELAGGREGATES(${g()},#5,$,$,#22,(#24))`],
    [29, `IFCRELAGGREGATES(${g()},#5,$,$,#24,(#26))`],
    [30, 'IFCLOCALPLACEMENT(#25,#14)'],
    [31, 'IFCCARTESIANPOINT((2.5,0.1))'],
    [32, 'IFCDIRECTION((1.,0.))'],
    [33, 'IFCAXIS2PLACEMENT2D(#31,#32)'],
    [34, 'IFCRECTANGLEPROFILEDEF(.AREA.,$,#33,5.,0.2)'],
    [35, 'IFCEXTRUDEDAREASOLID(#34,#14,#12,3.)'],
    [36, "IFCSHAPEREPRESENTATION(#16,'Body','SweptSolid',(#35))"],
    [37, 'IFCCARTESIANPOINT((0.,0.))'],
    [38, 'IFCCARTESIANPOINT((5.,0.))'],
    [39, 'IFCPOLYLINE((#37,#38))'],
    [40, "IFCSHAPEREPRESENTATION(#17,'Axis','Curve2D',(#39))"],
    [41, 'IFCPRODUCTDEFINITIONSHAPE($,$,(#40,#36))'],
    [42, `IFCWALL(${g()},#5,'Wall A',$,$,#30,#41,$,.STANDARD.)`],
    [43, "IFCMATERIAL('Concrete',$,$)"],
    [44, 'IFCMATERIALLAYER(#43,0.2,$,$,$,$,$)'],
    [45, "IFCMATERIALLAYERSET((#44),'Wall 200',$)"],
    [46, 'IFCMATERIALLAYERSETUSAGE(#45,.AXIS2.,.POSITIVE.,-0.1,$)'],
    [47, `IFCRELASSOCIATESMATERIAL(${g()},#5,$,$,(#60),#46)`],
    [48, `IFCWALLTYPE(${g()},#5,'Wall 200',$,$,$,$,$,$,.STANDARD.)`],
    [49, `IFCRELDEFINESBYTYPE(${g()},#5,$,$,(#42,#60),#48)`],
    [50, 'IFCLOCALPLACEMENT(#30,#51)'],
    [51, 'IFCAXIS2PLACEMENT3D(#52,$,$)'],
    [52, 'IFCCARTESIANPOINT((1.,0.,0.))'],
    [53, 'IFCRECTANGLEPROFILEDEF(.AREA.,$,#54,1.,0.2)'],
    [54, 'IFCAXIS2PLACEMENT2D(#55,$)'],
    [55, 'IFCCARTESIANPOINT((0.5,0.1))'],
    [56, 'IFCEXTRUDEDAREASOLID(#53,#14,#12,2.1)'],
    [57, "IFCSHAPEREPRESENTATION(#16,'Body','SweptSolid',(#56))"],
    [58, 'IFCPRODUCTDEFINITIONSHAPE($,$,(#57))'],
    [59, `IFCOPENINGELEMENT(${g()},#5,'Door opening',$,$,#50,#58,$,.OPENING.)`],
    [60, `IFCWALLSTANDARDCASE(${g()},#5,'Wall B',$,$,#90,#91,$,.STANDARD.)`],
    [61, `IFCRELVOIDSELEMENT(${g()},#5,$,$,#42,#59)`],
    [62, `IFCDOOR(${g()},#5,'Door',$,$,#63,$,$,2.1,1.,.DOOR.,.SINGLE_SWING_LEFT.,$)`],
    [63, 'IFCLOCALPLACEMENT(#50,#14)'],
    [64, `IFCRELFILLSELEMENT(${g()},#5,$,$,#59,#62)`],
    [70, `IFCOPENINGELEMENT(${g()},#5,'Window opening',$,$,#71,#58,$,.OPENING.)`],
    [71, 'IFCLOCALPLACEMENT(#90,#51)'],
    [72, `IFCRELVOIDSELEMENT(${g()},#5,$,$,#60,#70)`],
    [73, `IFCWINDOW(${g()},#5,'Window',$,$,#74,$,$,1.2,1.,.WINDOW.,.SINGLE_PANEL.,$)`],
    [74, 'IFCLOCALPLACEMENT(#71,#14)'],
    [75, `IFCRELFILLSELEMENT(${g()},#5,$,$,#70,#73)`],
    [80, 'IFCCARTESIANPOINT((5.,5.))'],
    [81, 'IFCCARTESIANPOINT((0.,5.))'],
    [82, 'IFCPOLYLINE((#37,#38,#80,#81,#37))'],
    [83, 'IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#82)'],
    [84, 'IFCEXTRUDEDAREASOLID(#83,#14,#12,0.2)'],
    [85, "IFCSHAPEREPRESENTATION(#16,'Body','SweptSolid',(#84))"],
    [86, 'IFCPRODUCTDEFINITIONSHAPE($,$,(#85))'],
    [87, 'IFCLOCALPLACEMENT(#25,#14)'],
    [88, `IFCSLAB(${g()},#5,'Slab',$,$,#87,#86,$,.FLOOR.)`],
    [90, 'IFCLOCALPLACEMENT(#25,#92)'],
    [91, 'IFCPRODUCTDEFINITIONSHAPE($,$,(#94,#95))'],
    [92, 'IFCAXIS2PLACEMENT3D(#93,$,$)'],
    [93, 'IFCCARTESIANPOINT((0.,5.,0.))'],
    [94, "IFCSHAPEREPRESENTATION(#17,'Axis','Curve2D',(#39))"],
    [95, "IFCSHAPEREPRESENTATION(#16,'Body','SweptSolid',(#35))"],
    [100, 'IFCLOCALPLACEMENT(#25,#14)'],
    [101, `IFCSPACE(${g()},#5,'Room 1',$,$,#100,#86,'Living',.ELEMENT.,.INTERNAL.,$)`],
    [102, `IFCRELAGGREGATES(${g()},#5,$,$,#26,(#101))`],
    [110, 'IFCCARTESIANPOINT((0.,-1.))'],
    [111, 'IFCCARTESIANPOINT((0.,6.))'],
    [112, 'IFCPOLYLINE((#110,#111))'],
    [113, "IFCGRIDAXIS('A',#112,.T.)"],
    [114, 'IFCCARTESIANPOINT((-1.,0.))'],
    [115, 'IFCCARTESIANPOINT((6.,0.))'],
    [116, 'IFCPOLYLINE((#114,#115))'],
    [117, "IFCGRIDAXIS('1',#116,.T.)"],
    [118, 'IFCLOCALPLACEMENT(#25,#14)'],
    [119, `IFCGRID(${g()},#5,'Grid',$,$,#118,$,(#113),(#117),$,.RECTANGULAR.)`],
    [120, `IFCRELCONTAINEDINSPATIALSTRUCTURE(${g()},#5,$,$,(#42,#60,#62,#73,#88,#119),#26)`],
    [130, "IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI90'),$)"],
    [131, "IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$)"],
    [132, `IFCPROPERTYSET(${g()},#5,'Pset_WallCommon',$,(#130,#131))`],
    [133, `IFCRELDEFINESBYPROPERTIES(${g()},#5,$,$,(#42),#132)`],
    [134, "IFCQUANTITYLENGTH('Length',$,$,5.,$)"],
    [135, "IFCQUANTITYAREA('NetSideArea',$,$,13.,$)"],
    [136, `IFCELEMENTQUANTITY(${g()},#5,'Qto_WallBaseQuantities',$,$,(#134,#135))`],
    [137, `IFCRELDEFINESBYPROPERTIES(${g()},#5,$,$,(#42),#136)`],
  ];
  return new Map(lines);
}

export const DEFAULT_HEADER = {
  description: "('ViewDefinition [ReferenceView_V1.2]')",
  name: "'corpus.ifc','2026-11-19T00:00:00',('Jane Doe'),('Example Org'),'ifc-lite','ifc-lite corpus',''",
  schema: 'IFC4',
};

export function serialize(records: Records, header = DEFAULT_HEADER): string {
  const data = [...records.entries()].sort((a, b) => a[0] - b[0]).map(([id, body]) => `#${id}=${body};`);
  return [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(${header.description},'2;1');`,
    `FILE_NAME(${header.name});`,
    `FILE_SCHEMA(('${header.schema}'));`,
    'ENDSEC;',
    'DATA;',
    ...data,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
