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

/**
 * An IFC2X3 file whose objects are classes IFC4 dropped, so the parser's IFC4
 * codegen pin knows none of them.
 *
 * - `IfcMove` (an `IfcTask` subtype) and `IfcSpaceProgram` (an `IfcControl`)
 *   are `IfcObjectDefinition`s with real GlobalIds in slot 0, and are not
 *   `IfcProduct`s, so the `EntityTable` does not hold them.
 * - `IfcSymbolStyle` is a *resource*: no GlobalId at all, a Name in slot 0. Its
 *   class name ends in `STYLE`, which is one of the parser's two name-based
 *   branches, so the table does hold it — with `hatch` in the GlobalId column.
 * - `IfcGasTerminalType` is a real `IfcTypeObject`, reached through the other
 *   name-based branch (`…TYPE`).
 *
 * Deciding membership from the IFC4 pin alone gets all three wrong at once.
 */
export function legacyScheduleModel(moveGuid: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
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
#70= IFCWALLSTANDARDCASE('${guid('WALL')}',$,'Wall A',$,$,#40,$,'tagA');
#90= IFCMOVE('${moveGuid}',$,'Move A',$,$,'ID1',$,$,.F.,$,#41,#41,$);
#91= IFCSPACEPROGRAM('${guid('SPGM')}',$,'Program A',$,$,'SP1',$,$,$,$);
#92= IFCSYMBOLSTYLE('hatch',#93);
#93= IFCDEFINEDSYMBOL($,$);
#94= IFCGASTERMINALTYPE('${guid('GTTY')}',$,'GT',$,$,$,$,$,$,.GASAPPLIANCE.);
#96= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#70),#41);
ENDSEC;
END-ISO-10303-21;
`;
}

/**
 * The `Tag` scoping fixture (issue #2021), in both directions at once.
 *
 * Two `IfcWallType`s that agree on everything the fingerprint hashed before
 * `Tag` did — same Name, same ElementType, same PredefinedType, no properties —
 * and differ only in `Tag`. That is Duplex's eight `'800 mm'`
 * `IfcFurnitureType`s reduced to two, and a type object has no geometry hash,
 * so before #2021 nothing could separate them.
 *
 * Two `IfcWall`s built the same way, differing only in `Tag`. An occurrence's
 * `Tag` is the authoring tool's element id rather than design content, so it
 * must stay OUT of the hash — these two must keep hashing identically.
 */
export function typeTagModel(): string {
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
#50= IFCWALLTYPE('${guid('TYPA')}',$,'800 mm',$,$,$,$,'157200','800 mm',.STANDARD.);
#51= IFCWALLTYPE('${guid('TYPB')}',$,'800 mm',$,$,$,$,'157607','800 mm',.STANDARD.);
#70= IFCWALL('${guid('WALA')}',$,'Wall',$,$,#40,$,'tagA',.STANDARD.);
#71= IFCWALL('${guid('WALB')}',$,'Wall',$,$,#40,$,'tagB',.STANDARD.);
#80= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#70,#71),#41);
ENDSEC;
END-ISO-10303-21;
`;
}

/**
 * The same `Tag` question on a class the IFC4 codegen pin does not carry.
 *
 * `IfcRailType` is IFC4X3-only. Its inheritance chain resolves across the
 * bundled schemas, so it is correctly in scope and correctly an `IfcTypeObject`
 * — but its *attribute names* do not resolve through the pinned registry
 * (`getAttributeNames('IfcRailType')` is empty, `getAttributeNamesAcrossSchemas`
 * gives all ten with `Tag` at index 7). A `Tag` lookup that goes through the pin
 * therefore finds nothing and silently no-ops on exactly the infrastructure
 * classes IFC4X3 exists for, while passing every test written against IFC2X3 and
 * IFC4. Same pinned-registry family as #2001/#2003.
 */
export function railTypeModel(): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#50= IFCRAILTYPE('${guid('RALA')}',$,'60E1',$,$,$,$,'157200','60E1',.RACKRAIL.);
#51= IFCRAILTYPE('${guid('RALB')}',$,'60E1',$,$,$,$,'157607','60E1',.RACKRAIL.);
ENDSEC;
END-ISO-10303-21;
`;
}

export const BASE_MODEL = model(guid('OLDA'), guid('OLDB'));
/** Same building, re-exported: the two walls carry brand-new GlobalIds. */
export const HEAD_MODEL = model(guid('NEWA'), guid('NEWB'));
