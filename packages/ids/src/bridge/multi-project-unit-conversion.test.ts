/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A file with more than one `IFCPROJECT` is not malformed: `MergedExporter`'s
 * documented `auto` unit-reconciliation mode (see issue #1332) legitimately
 * produces one when federating models that declare different length units —
 * it keeps each source model's own `IFCPROJECT`/`IFCUNITASSIGNMENT` rather
 * than rescaling raw values. #3554 found and fixed one consumer of this
 * shape (`MergedExporter`'s reader-side material-layer thickness); this pins
 * a second, compliance-severity one: IDS length-property comparison.
 *
 * `collectAllPropertySets` (`properties.ts`) used to read a single
 * `store.lengthUnitScale` — resolved once, from the file's FIRST
 * `IFCPROJECT` — for every entity regardless of which project it actually
 * belongs to. An `IfcWall` belonging to a LATER project with a DIFFERENT
 * declared length unit was scaled by the wrong project's factor: quietly
 * wrong, not absent, and compliance-critical — an IDS `Width >= 200mm`
 * requirement evaluates against the wrongly-scaled value and can flip
 * pass to fail (or the reverse) with no signal to the author.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from './index.js';

// Two IFCPROJECTs, each with its OWN IFCUNITASSIGNMENT:
//  - Project 1 (first in the file): LENGTHUNIT = millimetres, and owns Wall #7
//    via IFCSITE #24 -> IFCRELAGGREGATES #25 -> IFCRELCONTAINEDINSPATIALSTRUCTURE #26.
//    Wall #7 is CONTAINED deliberately: with no containment edge it resolves to
//    no owner and reads the store-wide fallback, so it would stay green even if
//    a first-project entity were mis-resolved to the second project.
//  - Project 2 (second in the file): LENGTHUNIT = metres, and owns Wall #19
//    via IFCSITE #17 -> IFCRELAGGREGATES #18 -> IFCRELCONTAINEDINSPATIALSTRUCTURE #20.
// Wall #19's Pset_WallCommon.Width is authored as 0.4 (already metres, per
// its OWN project's unit) — the correct base-SI IDS-facing value is 0.4.
// Reading it with project 1's millimetre scale (0.001) instead gives 0.0004.
//
// Wall #7 (control) belongs to project 1 and is authored in millimetres
// (300 -> 0.3 m); its correct scale is project 1's own, so it is identical
// whether or not per-entity resolution is applied.
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2022-10-07T13:48:43',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,'Primary-mm',$,$,$,$,$,#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,.MILLI.,.SQUARE_METRE.);
#4=IFCSIUNIT(*,.VOLUMEUNIT.,.MILLI.,.CUBIC_METRE.);
#5=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#6=IFCUNITASSIGNMENT((#4,#2,#5,#3));
#7=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,$,$,$,$,$,$,$);
#8=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(300.),$);
#9=IFCPROPERTYSET('1z6M0fVLDCPBUYwtcqp5aq',$,'Pset_WallCommon',$,(#8));
#10=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#7),#9);
#11=IFCPROJECT('0hqIFTRjfV6AWq_bMtnZw2',$,'Secondary-m',$,$,$,$,$,#16);
#12=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#13=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#14=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#15=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#16=IFCUNITASSIGNMENT((#14,#12,#15,#13));
#17=IFCSITE('3z6M0fVLDCPBUYwtcqp5bq',$,$,$,$,$,$,$,$);
#18=IFCRELAGGREGATES('4z6M0fVLDCPBUYwtcqp5cq',$,$,$,#11,(#17));
#19=IFCWALL('5z6M0fVLDCPBUYwtcqp5dq',$,$,$,$,$,$,$,$);
#20=IFCRELCONTAINEDINSPATIALSTRUCTURE('6z6M0fVLDCPBUYwtcqp5eq',$,$,$,(#19),#17);
#21=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(0.4),$);
#22=IFCPROPERTYSET('7z6M0fVLDCPBUYwtcqp5fq',$,'Pset_WallCommon',$,(#21));
#23=IFCRELDEFINESBYPROPERTIES('8z6M0fVLDCPBUYwtcqp5gq',$,$,$,(#19),#22);
#24=IFCSITE('9z6M0fVLDCPBUYwtcqp5hq',$,$,$,$,$,$,$,$);
#25=IFCRELAGGREGATES('Az6M0fVLDCPBUYwtcqp5iq',$,$,$,#1,(#24));
#26=IFCRELCONTAINEDINSPATIALSTRUCTURE('Bz6M0fVLDCPBUYwtcqp5jq',$,$,$,(#7),#24);
ENDSEC;
END-ISO-10303-21;
`;

// Project 2 here declares NO `UnitsInContext` at all (OPTIONAL on IfcContext).
// Wall #19 is owned by it and authored 300., which is millimetres per the only
// unit declaration in the file. Resolving "this project's length unit" to an
// unconfirmed 1.0 would report 300 m for a 0.3 m wall.
const IFC_OWNER_DECLARES_NO_UNITS = IFC
  .replace("#11=IFCPROJECT('0hqIFTRjfV6AWq_bMtnZw2',$,'Secondary-m',$,$,$,$,$,#16);",
           "#11=IFCPROJECT('0hqIFTRjfV6AWq_bMtnZw2',$,'Secondary-none',$,$,$,$,$,$);")
  .replace("#21=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(0.4),$);",
           "#21=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(300.),$);");

const IDS_WIDTH_AT_LEAST_200MM = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Wall width at least 200mm</title></info>
  <specifications>
    <specification name="Width at least 200mm" ifcVersion="IFC4">
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCLENGTHMEASURE">
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>Width</simpleValue></baseName>
          <value>
            <xs:restriction base="xs:double">
              <xs:minInclusive value="0.2"/>
            </xs:restriction>
          </value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>
`;

async function parseIfc(source: string) {
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer);
}

describe('IDS property scale on a multi-IFCPROJECT (federated-merge) file', () => {
  it('reads the SECOND project entity property with its own project scale, not the first project\'s', async () => {
    const store = await parseIfc(IFC);
    const accessor = createDataAccessor(store);
    const pset = accessor
      .getPropertySets(19)
      .find((p) => p.name === 'Pset_WallCommon');
    const width = pset?.properties.find((p) => p.name === 'Width');

    // Wall #19 belongs to the SECOND project (metres); its raw authored
    // value 0.4 IS already the base-SI value. Reading it with the FIRST
    // project's millimetre scale (0.001) instead of the correct 1.0
    // silently reports 0.0004.
    expect(width?.value).toBe(0.4);
  });

  it('keeps the control entity (first project, unaffected by the fix) at its own correct scale', async () => {
    const store = await parseIfc(IFC);
    const accessor = createDataAccessor(store);
    const pset = accessor.getPropertySets(7).find((p) => p.name === 'Pset_WallCommon');
    const width = pset?.properties.find((p) => p.name === 'Width');

    // Wall #7 belongs to the FIRST project (millimetres); 300 mm -> 0.3 m.
    expect(width?.value).toBe(0.3);
  });

  it('falls back to the file-wide scale when the OWNING project declares no length unit', async () => {
    // ABSENCE MUST NOT READ AS SUCCESS. `extractLengthUnitScale` answers an
    // unconfirmed 1.0 both for "declares metres" and "declares nothing", so
    // taking it unconditionally turns this 300 mm wall into a 300 m one — a
    // silent 1000x, on the exact shape MergedExporter produces when it
    // federates a model that carries no unit declaration.
    const store = await parseIfc(IFC_OWNER_DECLARES_NO_UNITS);
    const accessor = createDataAccessor(store);
    const pset = accessor.getPropertySets(19).find((p) => p.name === 'Pset_WallCommon');
    const width = pset?.properties.find((p) => p.name === 'Width');

    expect(width?.value).toBe(0.3);
  });

  it('passes a >=200mm requirement for a second-project wall authored at 400mm', async () => {
    const store = await parseIfc(IFC);
    const accessor = createDataAccessor(store);
    const doc = parseIDS(IDS_WIDTH_AT_LEAST_200MM);
    const report = await validateIDS(doc, accessor, {
      modelId: 'm1',
      schemaVersion: 'IFC4',
      entityCount: 2,
    });

    const spec = report.specificationResults[0];
    // Both walls satisfy Width >= 200mm at their own correct scale
    // (300mm and 400mm respectively). Scaling wall #19 by the first
    // project's millimetre factor instead makes it read as 0.4mm and fail.
    expect(spec.applicableCount).toBe(2);
    expect(spec.status).toBe('pass');
    expect(spec.failedCount).toBe(0);
  });
});
