/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS `<property>` requirements against area/volume-typed values
 * (`IFCAREAMEASURE`, `IFCVOLUMEMEASURE`) must be converted to base SI
 * before comparison, exactly like `IFCLENGTHMEASURE` already is (see
 * `quantity-unit-conversion.test.ts` / PR #3458 for the length case, and
 * the corpus case `property/pass-unit_conversions_shall_take_place_to_ids_
 * nominated_standard_units_2_2`, which pins length only).
 *
 * Per the IDS spec (mirrored in `units.ts`'s own doc comment): IDS literal
 * values for IFC measure types are always base SI units, while the IFC
 * store keeps the raw author value. `applyUnitConversion` gated conversion
 * on `IFCLENGTHMEASURE`/`IFCPOSITIVELENGTHMEASURE` alone, so an
 * `IFCAREAMEASURE` or `IFCVOLUMEMEASURE` value was compared raw — a
 * millimetre-authored project's `NetSideArea` of `2000000` (mm²) is `2`
 * m² and must satisfy an IDS literal of `2`, but was compared against the
 * raw `2000000` instead.
 *
 * Unlike length, area does NOT scale by the length factor: it scales by
 * the SQUARE of it, and volume by the CUBE. Getting the exponent wrong in
 * the same direction as the length fix (i.e. multiplying by `scale` once
 * instead of `scale ** 2` / `scale ** 3`) is the most likely failure mode
 * here, so the exponent is asserted explicitly below (both in
 * `units.test.ts` at the `applyUnitConversion` level, and end-to-end here).
 *
 * This affects both `Pset_*` (`IfcPropertySet`) and `Qto_*`
 * (`IfcElementQuantity`) — both go through the same `applyUnitConversion`
 * call via `projectProperty` (`properties.ts`).
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from './index.js';

// Millimetre-authored project: LENGTHUNIT, AREAUNIT and VOLUMEUNIT are all
// declared MILLI-prefixed. A wall carries:
//   - a Pset_ custom property "Area" typed IfcAreaMeasure, raw 2000000 (mm²)
//     i.e. 2 m², and "Volume" typed IfcVolumeMeasure, raw 3000000000 (mm³)
//     i.e. 3 m³.
//   - a Qto_WallBaseQuantities.NetSideArea IfcQuantityArea, same raw value.
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
#8=IFCPROPERTYSINGLEVALUE('Area',$,IFCAREAMEASURE(2000000.),$);
#9=IFCPROPERTYSINGLEVALUE('Volume',$,IFCVOLUMEMEASURE(3000000000.),$);
#10=IFCPROPERTYSET('0FhAr5rvX3vfPGjNbwau9F',$,'Pset_WallCommon',$,(#8,#9));
#11=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#7),#10);
#12=IFCQUANTITYAREA('NetSideArea',$,$,2000000.,$);
#13=IFCELEMENTQUANTITY('16MocU_IDOF8_x3Iqllz0d',$,'Qto_WallBaseQuantities',$,$,(#12));
#14=IFCRELDEFINESBYPROPERTIES('2xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#7),#13);
ENDSEC;
END-ISO-10303-21;
`;

// Metre-authored (scale 1) project, otherwise identical shape — must be
// unaffected by the fix: raw author value already equals the base-SI value.
const IFC_METRES = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2022-10-07T13:48:43',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#4=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#5=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#6=IFCUNITASSIGNMENT((#4,#2,#5,#3));
#7=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,$,$,$,$,$,$,$);
#8=IFCPROPERTYSINGLEVALUE('Area',$,IFCAREAMEASURE(2.),$);
#9=IFCPROPERTYSET('0FhAr5rvX3vfPGjNbwau9F',$,'Pset_WallCommon',$,(#8));
#10=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#7),#9);
ENDSEC;
END-ISO-10303-21;
`;

// LENGTHUNIT is MILLI, but AREAUNIT is declared explicitly as a plain
// (unprefixed) SQUARE_METRE — i.e. the file's own declared area unit is
// ALREADY base SI, unrelated to the length unit's milli prefix. IFC does
// not require AREAUNIT to be derived from LENGTHUNIT (they are declared
// independently in `IfcUnitAssignment`), so a correct implementation must
// read the declared AREAUNIT rather than derive `lengthScale ** 2`
// (which here would be wrong: 0.001 ** 2 = 1e-6, not 1).
const IFC_DECLARED_AREA_UNIT_DIVERGES_FROM_LENGTH = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2022-10-07T13:48:43',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,#5);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#4=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#5=IFCUNITASSIGNMENT((#2,#4,#3));
#6=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,$,$,$,$,$,$,$);
#7=IFCPROPERTYSINGLEVALUE('Area',$,IFCAREAMEASURE(2.),$);
#8=IFCPROPERTYSET('0FhAr5rvX3vfPGjNbwau9F',$,'Pset_WallCommon',$,(#7));
#9=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#6),#8);
#10=IFCQUANTITYAREA('NetSideArea',$,$,2.,$);
#11=IFCELEMENTQUANTITY('3sIvBaNRfL2RQijKS1p08K',$,'Qto_WallBaseQuantities',$,$,(#10));
#12=IFCRELDEFINESBYPROPERTIES('2ydxk9rHYL5izPocwNeYKX',$,$,$,(#6),#11);
ENDSEC;
END-ISO-10303-21;
`;

const IDS_AREA_IN_SQUARE_METRES = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Area must be reported in square metres</title></info>
  <specifications>
    <specification name="Area in square metres" ifcVersion="IFC4">
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCAREAMEASURE">
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>Area</simpleValue></baseName>
          <value><simpleValue>2</simpleValue></value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>
`;

const IDS_QTO_AREA_IN_SQUARE_METRES = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Qto area must be reported in square metres</title></info>
  <specifications>
    <specification name="Qto area in square metres" ifcVersion="IFC4">
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCAREAMEASURE">
          <propertySet><simpleValue>Qto_WallBaseQuantities</simpleValue></propertySet>
          <baseName><simpleValue>NetSideArea</simpleValue></baseName>
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

describe('IDS area/volume unit conversion (Pset_* and Qto_*)', () => {
  it('scales a Pset_ IFCAREAMEASURE by the square of the length factor, not the length factor', async () => {
    const store = await parseIfc(IFC);
    const accessor = createDataAccessor(store);
    const pset = accessor.getPropertySets(7).find((p) => p.name === 'Pset_WallCommon');
    const area = pset?.properties.find((p) => p.name === 'Area');

    // Raw author value is 2,000,000 mm² == 2 m². A wrong-exponent fix that
    // reused the LENGTH scale (0.001) instead of squaring it (1e-6) would
    // produce 2000, not 2 — this is the assertion that pins the exponent.
    expect(area?.value).toBe(2);
  });

  it('scales a Pset_ IFCVOLUMEMEASURE by the cube of the length factor', async () => {
    const store = await parseIfc(IFC);
    const accessor = createDataAccessor(store);
    const pset = accessor.getPropertySets(7).find((p) => p.name === 'Pset_WallCommon');
    const volume = pset?.properties.find((p) => p.name === 'Volume');

    // 3,000,000,000 mm³ == 3 m³. Cubing the length scale (1e-3 ** 3 = 1e-9),
    // not squaring or leaving it linear, is what makes this 3 rather than
    // 3,000,000 or 3,000.
    expect(volume?.value).toBe(3);
  });

  it('scales a Qto_ IFCAREAMEASURE (IfcQuantityArea) the same way as the Pset_ path', async () => {
    const store = await parseIfc(IFC);
    const accessor = createDataAccessor(store);
    const pset = accessor.getPropertySets(7).find((p) => p.name === 'Qto_WallBaseQuantities');
    const area = pset?.properties.find((p) => p.name === 'NetSideArea');

    expect(area?.value).toBe(2);
  });

  it('passes a millimetre-authored Pset_ area against an IDS literal in square metres', async () => {
    const store = await parseIfc(IFC);
    const accessor = createDataAccessor(store);
    const doc = parseIDS(IDS_AREA_IN_SQUARE_METRES);
    const report = await validateIDS(doc, accessor, {
      modelId: 'm1',
      schemaVersion: 'IFC4',
      entityCount: 1,
    });

    // RED (pre-fix): applyUnitConversion did not recognise IFCAREAMEASURE,
    // so the raw 2,000,000 was compared against the IDS literal 2 and the
    // requirement false-failed a model that actually complies.
    const spec = report.specificationResults[0];
    expect(spec.applicableCount).toBe(1);
    expect(spec.status).toBe('pass');
    expect(spec.failedCount).toBe(0);
  });

  it('passes a millimetre-authored Qto_ area against an IDS literal in square metres', async () => {
    const store = await parseIfc(IFC);
    const accessor = createDataAccessor(store);
    const doc = parseIDS(IDS_QTO_AREA_IN_SQUARE_METRES);
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

  it('leaves a metre-authored (scale 1) project unaffected', async () => {
    const store = await parseIfc(IFC_METRES);
    const accessor = createDataAccessor(store);
    const pset = accessor.getPropertySets(7).find((p) => p.name === 'Pset_WallCommon');
    const area = pset?.properties.find((p) => p.name === 'Area');

    expect(area?.value).toBe(2);
  });

  it('reads the file-declared AREAUNIT rather than deriving one from a divergent LENGTHUNIT', async () => {
    // LENGTHUNIT is MILLI but AREAUNIT is declared as a plain (unprefixed)
    // SQUARE_METRE — IFC does not require AREAUNIT to be derived from
    // LENGTHUNIT, they are independent entries in IfcUnitAssignment. The
    // raw author value 2 is ALREADY base SI here; deriving from the length
    // scale instead (0.001 ** 2 = 1e-6) would wrongly produce 0.000002.
    const store = await parseIfc(IFC_DECLARED_AREA_UNIT_DIVERGES_FROM_LENGTH);
    const accessor = createDataAccessor(store);
    const pset = accessor.getPropertySets(6).find((p) => p.name === 'Pset_WallCommon');
    const area = pset?.properties.find((p) => p.name === 'Area');

    expect(area?.value).toBe(2);
  });

  // The Qto_ sibling of the test above. Every other Qto_ case in this file
  // does declare an AREAUNIT, but declares it as MILLI SQUARE_METRE, and
  // the resolver raises the prefix to the unit's dimension
  // (project-units.ts: prefixPower 2), so its scale is numerically the
  // same 1e-6 the `lengthScale ** 2` fallback derives. Agreeing, they
  // cannot tell the two apart, and dropping `measureScales` from the
  // quantity path leaves every one of them green.
  //
  // Divergence needs the unprefixed SQUARE_METRE of the fixture below
  // against a MILLI length, where the declared scale is 1 and the derived
  // one 1e-6. Adding an AREAUNIT to a fixture is therefore not what makes
  // it discriminating; declaring one that does not agree with the length
  // unit is.
  it('reads the file-declared AREAUNIT on the Qto_ path too, not just the Pset_ one', async () => {
    const store = await parseIfc(IFC_DECLARED_AREA_UNIT_DIVERGES_FROM_LENGTH);
    const accessor = createDataAccessor(store);
    const qset = accessor.getPropertySets(6).find((p) => p.name === 'Qto_WallBaseQuantities');
    const area = qset?.properties.find((p) => p.name === 'NetSideArea');

    expect(area?.value).toBe(2);
  });
});
