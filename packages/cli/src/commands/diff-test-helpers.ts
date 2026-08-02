/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared STEP fixtures for the `diff --by-content` test suites (issue #1891). */

/** A 22-character IFC GlobalId from a short mnemonic. */
export function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

/** A minimal but real model: project, units, context, storey, two named walls
 *  with a spatial containment relation. `wallA`/`wallB` are the GlobalIds, so a
 *  "re-export" is the same call with different ones. */
export function model(wallA: string, wallB: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#50= IFCLOCALPLACEMENT(#40,#21);
#60= IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,2.,0.2);
#61= IFCEXTRUDEDAREASOLID(#60,#21,#62,3.);
#62= IFCDIRECTION((0.,0.,1.));
#63= IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#61));
#64= IFCPRODUCTDEFINITIONSHAPE($,$,(#63));
#70= IFCWALL('${wallA}',$,'Wall A',$,$,#50,#64,'tagA',$);
#71= IFCWALL('${wallB}',$,'Wall B',$,$,#50,#64,'tagB',$);
#80= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#70,#71),#41);
ENDSEC;
END-ISO-10303-21;
`;
}

/**
 * One entity from each `IfcRoot` branch, plus classes that are not `IfcRoot` at
 * all and classes no schema registry knows.
 *
 * - `IfcTask` / `IfcActor` are `IfcObjectDefinition`s the columnar parser does
 *   not put in its `EntityTable` (they are not `IfcProduct` subtypes), so their
 *   GlobalId has to come from the STEP record.
 * - `IfcRelDefinesByProperties` is an `IfcRelationship` and `IfcPropertySet` is
 *   an `IfcPropertyDefinition`: both carry GlobalIds, both stay out.
 * - `IfcMaterial` has no GlobalId at all — its first attribute is a Name, which
 *   the parser's positional extraction stores in the table's GlobalId column.
 * - `IfcVendorTask`, `IfcVendorWallType` and `IfcRelVendorLink` are in no schema
 *   registry. The parser's two name-based branches (`…TYPE`, `IFCREL…`) still
 *   take the last two into its table.
 */
export function scheduleModel(taskGuid: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#70= IFCWALL('${guid('WALL')}',$,'Wall A',$,$,#40,$,'tagA',$);
#80= IFCMATERIAL('brick',$,$);
#81= IFCPROPERTYSET('${guid('PSET')}',$,'Pset_X',$,(#82));
#82= IFCPROPERTYSINGLEVALUE('P',$,IFCLABEL('v'),$);
#83= IFCRELDEFINESBYPROPERTIES('${guid('RELP')}',$,$,$,(#70),#81);
#90= IFCTASK('${taskGuid}',$,'Pour slab',$,$,$,$,'ID1',$,.F.,$,$,.CONSTRUCTION.);
#91= IFCACTOR('${guid('ACTR')}',$,'Site manager',$,$,#92,$);
#92= IFCPERSON($,'Doe','Jane',$,$,$,$,$);
#96= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#70),#41);
#97= IFCVENDORTASK('${guid('VEND')}',$,'Custom',$);
#98= IFCVENDORWALLTYPE('${guid('VTYP')}',$,'Custom type',$,$,$,$,$,$,$);
#99= IFCRELVENDORLINK('${guid('VREL')}',$,$,$,(#70),#41);
ENDSEC;
END-ISO-10303-21;
`;
}

export const BASE_MODEL = model(guid('OLDA'), guid('OLDB'));
/** Same building, re-exported: the two walls carry brand-new GlobalIds. */
export const HEAD_MODEL = model(guid('NEWA'), guid('NEWB'));
