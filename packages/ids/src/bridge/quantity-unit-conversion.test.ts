/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS `<property>` requirements against `IfcElementQuantity` (Qto_*) values
 * must go through the same base-SI unit conversion as `IfcPropertySet`
 * (Pset_*) values.
 *
 * Per the IDS spec (mirrored in `units.ts`'s own doc comment, and already
 * proven for Pset_* by the vendored buildingSMART corpus case
 * `property/pass-unit_conversions_shall_take_place_to_ids_nominated_standard_units_2_2`):
 * IDS literal values for IFC measure types are always base SI units, while
 * the IFC store keeps the raw author value. A millimetre-authored project's
 * `IfcQuantityLength` of `2000` therefore means `2` metres and must compare
 * equal to an IDS literal of `2` — exactly like a millimetre-authored
 * `IfcPropertySingleValue` already does.
 *
 * `collectAllPropertySets` applied that conversion to instance/type/material
 * property sets via `projectProperty`, but `appendQuantitySets` built its
 * quantity values directly from the raw parser record and skipped it — so a
 * Qto_* length quantity was compared against the IDS literal in the wrong
 * unit space, false-failing a spec that a compliant model actually satisfies.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from './index.js';

// Millimetre-authored project (IFCSIUNIT ...MILLI.,.METRE.): a wall whose
// Qto_WallBaseQuantities.Length is stored as the raw author value 2000 (mm),
// i.e. 2 metres.
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2022-10-07T13:48:43',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,.MILLI.,.SQUARE_METRE.);
#4=IFCSIUNIT(*,.VOLUMEUNIT.,.MILLI.,.CUBIC_METRE.);
#5=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#6=IFCUNITASSIGNMENT((#4,#2,#5,#3));
#7=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,$,$,$,$,$,$,$);
#8=IFCELEMENTQUANTITY('16MocU_IDOF8_x3Iqllz0d',$,'Qto_WallBaseQuantities',$,$,(#10));
#9=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#7),#8);
#10=IFCQUANTITYLENGTH('Length',$,$,2000.,$);
ENDSEC;
END-ISO-10303-21;
`;

const IDS_LENGTH_IN_METRES = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Qto length must be reported in metres</title></info>
  <specifications>
    <specification name="Qto length in metres" ifcVersion="IFC4">
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCLENGTHMEASURE">
          <propertySet><simpleValue>Qto_WallBaseQuantities</simpleValue></propertySet>
          <baseName><simpleValue>Length</simpleValue></baseName>
          <value><simpleValue>2</simpleValue></value>
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

describe('IDS quantity unit conversion (Qto_*)', () => {
  it('scales an IfcQuantityLength by the project length unit before comparing', async () => {
    const store = await parseIfc(IFC);
    const accessor = createDataAccessor(store);
    const pset = accessor
      .getPropertySets(7)
      .find((p) => p.name === 'Qto_WallBaseQuantities');
    const length = pset?.properties.find((p) => p.name === 'Length');

    // Raw author value is 2000 (mm); the IDS-facing value must be the
    // base-SI conversion, 2 (m) — the same scale `projectProperty` already
    // applies to Pset_* length properties.
    expect(length?.value).toBe(2);
  });

  it('passes a millimetre-authored Qto_ length quantity against an IDS literal in metres', async () => {
    const store = await parseIfc(IFC);
    const accessor = createDataAccessor(store);
    const doc = parseIDS(IDS_LENGTH_IN_METRES);
    const report = await validateIDS(doc, accessor, {
      modelId: 'm1',
      schemaVersion: 'IFC4',
      entityCount: 1,
    });

    const spec = report.specificationResults[0];
    expect(spec.applicableCount).toBe(1);
    expect(spec.status).toBe('pass');
    expect(spec.failedCount).toBe(0);
  });
});
