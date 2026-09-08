/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit-scale STEP fixtures for the `diff --by-content` measure/quantity
 * scaling suites (split out of `diff-test-helpers.ts`, AGENTS.md's ~400-line
 * module-size house rule).
 */

import { guid } from './diff-test-helpers.js';

/**
 * One wall, same `GlobalId` throughout, carrying a `Pset_X.Width` typed as
 * `IfcLengthMeasure` — for probing whether a diff scales a project-scoped
 * measure PROPERTY the way it already scales a `Qto_` quantity. `unitDef` is
 * the file's `IFCUNITASSIGNMENT` member (metre vs. millimetre `IFCSIUNIT`) and
 * `widthValue` is the raw author-unit number stored in the STEP record.
 */
export function unitScaledPropertyModel(unitDef: string, widthValue: string): string {
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
${unitDef}
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#70= IFCWALL('${guid('WALL')}',$,'Wall A',$,$,#40,$,'tagA',$);
#81= IFCPROPERTYSET('${guid('PSET')}',$,'Pset_X',$,(#82));
#82= IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(${widthValue}),$);
#83= IFCRELDEFINESBYPROPERTIES('${guid('RELP')}',$,$,$,(#70),#81);
#96= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#70),#41);
ENDSEC;
END-ISO-10303-21;
`;
}

/** `unitScaledPropertyModel`, declared in whole metres. */
export const UNIT_SCALE_METRE_MODEL = unitScaledPropertyModel(
  '#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  '2.5',
);
/** Same wall, same physical width, re-authored in a millimetre-declared project. */
export const UNIT_SCALE_MILLIMETRE_MODEL = unitScaledPropertyModel(
  '#31= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
  '2500.',
);
/** Same millimetre project, but the width genuinely changed (2.5 m -> 3.0 m). */
export const UNIT_SCALE_MILLIMETRE_EDITED_MODEL = unitScaledPropertyModel(
  '#31= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
  '3000.',
);

/**
 * One wall carrying BOTH a `Qto_` quantity (`quantitySiScale`'s path) and a
 * `Pset_X.Width` measure property (`scaledPropertyValue`'s path) — the two
 * scaling fixes model-diff applies before hashing, which a rebase combined
 * into one shared `units` value (`buildDataInput`). Lets a test independently
 * flip only the quantity or only the property and confirm each is scaled
 * exactly once: a value scaled twice by an accidentally-chained path would
 * report `unchanged` as `modified`, or vice versa, on re-export into a
 * differently-unit-declared project.
 */
export function unitScaledCombinedModel(unitDef: string, qtyValue: string, widthValue: string): string {
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
${unitDef}
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#70= IFCWALL('${guid('WALL')}',$,'Wall A',$,$,#40,$,'tagA',$);
#80= IFCELEMENTQUANTITY('${guid('QSET')}',$,'Qto_WallBaseQuantities',$,$,(#81));
#81= IFCQUANTITYLENGTH('Length',$,$,${qtyValue});
#82= IFCRELDEFINESBYPROPERTIES('${guid('RELQ')}',$,$,$,(#70),#80);
#83= IFCPROPERTYSET('${guid('PSET')}',$,'Pset_X',$,(#84));
#84= IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(${widthValue}),$);
#85= IFCRELDEFINESBYPROPERTIES('${guid('RELP')}',$,$,$,(#70),#83);
#96= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#70),#41);
ENDSEC;
END-ISO-10303-21;
`;
}

/** `unitScaledCombinedModel`, declared in whole metres: quantity 4.0 m, width 2.5 m. */
export const UNIT_SCALE_COMBINED_METRE_MODEL = unitScaledCombinedModel(
  '#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  '4.0',
  '2.5',
);
/** Same wall, same physical quantity and width, re-authored in millimetres. */
export const UNIT_SCALE_COMBINED_MILLIMETRE_MODEL = unitScaledCombinedModel(
  '#31= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
  '4000.',
  '2500.',
);
/** Millimetre re-export, but ONLY the quantity genuinely changed (4.0 m -> 5.0 m). */
export const UNIT_SCALE_COMBINED_QUANTITY_EDITED_MODEL = unitScaledCombinedModel(
  '#31= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
  '5000.',
  '2500.',
);
/** Millimetre re-export, but ONLY the property genuinely changed (2.5 m -> 3.0 m). */
export const UNIT_SCALE_COMBINED_PROPERTY_EDITED_MODEL = unitScaledCombinedModel(
  '#31= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
  '4000.',
  '3000.',
);
