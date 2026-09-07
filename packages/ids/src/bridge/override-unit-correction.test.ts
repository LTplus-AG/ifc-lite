/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A `PropertyOverride` (the in-memory correction the viewer's IDS
 * correction dialog writes, #3929) must be expressed in the SAME two
 * frames every other property in this bridge already straddles:
 *
 *  - it is WRITTEN through `MutablePropertyView.setProperty`, which keeps
 *    values in the model's raw, author-unit frame (no unit conversion) —
 *    exactly the frame `PropertyOverride.value` mirrors here;
 *  - it is READ back through `resolveEffectivePropertySets`, which splices
 *    it alongside properties `projectProperty` (properties.ts) already
 *    scaled into base SI via `applyUnitConversion` — the frame every IDS
 *    literal is expressed in.
 *
 * Before this fix, `resolveEffectivePropertySets` spliced the override's
 * raw value straight into the projected pset with no conversion: under a
 * millimetre project, a corrected `IFCLENGTHMEASURE` raw value of `900`
 * (0.9 m, the physically-correct millimetre encoding of "0.9 metres")
 * read back as `900`, not `0.9` — 1000x too large, and an IDS
 * `>= 0.9` (metres) requirement would fail a value that is 0.9 m in
 * error, or pass one that isn't, depending on the raw magnitude involved.
 *
 * This fixture exercises the fix end-to-end through
 * `resolveEffectivePropertySets`/`validateIDS`, not just the `units.ts`
 * scale helpers directly (see `units.test.ts` for those).
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor, type PropertyOverride } from './index.js';
import { toRaw } from './units.js';

// Millimetre-authored project (LENGTHUNIT/AREAUNIT both MILLI-prefixed). A
// wall carries a too-small MinWidth (500 mm = 0.5 m, IDS requires >= 0.9 m),
// a too-small MinArea (100000 mm^2 = 0.1 m^2, IDS requires >= 0.9 m^2), and
// a non-measure FireRating label the correction path must never scale.
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
#8=IFCPROPERTYSINGLEVALUE('MinWidth',$,IFCLENGTHMEASURE(500.),$);
#9=IFCPROPERTYSINGLEVALUE('MinArea',$,IFCAREAMEASURE(100000.),$);
#10=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('NONE'),$);
#11=IFCPROPERTYSET('0FhAr5rvX3vfPGjNbwau9F',$,'Pset_WallCommon',$,(#8,#9,#10));
#12=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#7),#11);
ENDSEC;
END-ISO-10303-21;
`;

function idsSpec(name: string, baseName: string, dataType: string, minInclusive: string): string {
  return `    <specification name="${name}" ifcVersion="IFC4">
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="${dataType}">
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>${baseName}</simpleValue></baseName>
          <value>
            <xs:restriction base="xs:double">
              <xs:minInclusive value="${minInclusive}"/>
            </xs:restriction>
          </value>
        </property>
      </requirements>
    </specification>`;
}

const IDS = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Minimum wall dimensions</title></info>
  <specifications>
${idsSpec('MinWidth at least 0.9m', 'MinWidth', 'IFCLENGTHMEASURE', '0.9')}
${idsSpec('MinArea at least 0.9m2', 'MinArea', 'IFCAREAMEASURE', '0.9')}
  </specifications>
</ids>
`;

async function parseIfc(source: string) {
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer);
}

describe('IDS property-correction overlay unit scale (#3929 / #3943)', () => {
  it('control: the too-small raw values fail both requirements before any correction', async () => {
    const store = await parseIfc(IFC);
    const accessor = createDataAccessor(store);
    const doc = parseIDS(IDS);
    const report = await validateIDS(doc, accessor, {
      modelId: 'm1',
      schemaVersion: 'IFC4',
      entityCount: 1,
    });

    expect(report.specificationResults[0].status).toBe('fail');
    expect(report.specificationResults[1].status).toBe('fail');
  });

  it('a corrected MILLI-length override reads back as base-SI metres and satisfies the IDS requirement', async () => {
    const store = await parseIfc(IFC);

    // The raw value a correctly-scaled WRITE path stores for a user-typed
    // "0.9" (metres, the IDS-facing frame): 0.9 / 0.001 = 900 (mm) — the
    // physically-correct millimetre encoding of 0.9 metres. Asserted
    // directly against `toRaw`, the same function the viewer's correction
    // dialog calls before writing.
    const rawWritten = toRaw(0.9, 'IFCLENGTHMEASURE', { length: 0.001 });
    expect(rawWritten).toBe(900);

    const overrides = new Map<number, PropertyOverride[]>([
      [7, [{ psetName: 'Pset_WallCommon', propName: 'MinWidth', value: rawWritten as number }]],
    ]);
    const accessor = createDataAccessor(store, (id) => overrides.get(id));

    // READ direction: the overlay must forward-scale the raw override back
    // into the SAME base-SI frame every other property in this pset is
    // already in — 900 (mm) -> 0.9 (m), not the raw 900.
    const width = accessor.getPropertySets(7)
      .find((p) => p.name === 'Pset_WallCommon')
      ?.properties.find((p) => p.name === 'MinWidth');
    expect(width?.value).toBe(0.9);

    // IDS direction: re-validating against the SAME accessor now passes —
    // not because the raw 900 happens to satisfy ">= 0.9" numerically, but
    // because it was correctly read as 0.9 base-SI metres.
    const doc = parseIDS(IDS);
    const report = await validateIDS(doc, accessor, {
      modelId: 'm1',
      schemaVersion: 'IFC4',
      entityCount: 1,
    });
    const spec = report.specificationResults[0];
    expect(spec.status).toBe('pass');
    expect(spec.failedCount).toBe(0);
  });

  it('a corrected MILLI-area override scales by the SQUARE of the length factor, not the raw length scale', async () => {
    const store = await parseIfc(IFC);

    // 0.9 m^2 in a MILLI-area (1e-6 per mm^2) project: 0.9 / 1e-6 = 900000.
    // Mutation-check: dividing by the LENGTH scale (0.001) instead of the
    // area scale (1e-6) would give 900 — a value 1000x too small, still
    // silently wrong even though both are "SI".
    const rawWritten = toRaw(0.9, 'IFCAREAMEASURE', { length: 0.001, area: 1e-6 });
    // Floating-point division (0.9 / 1e-6) lands a ULP off 900000 —
    // `toBeCloseTo` tolerates that without loosening the 1000x-off
    // mutation check below.
    expect(rawWritten as number).toBeCloseTo(900000, 6);

    const overrides = new Map<number, PropertyOverride[]>([
      [7, [{ psetName: 'Pset_WallCommon', propName: 'MinArea', value: rawWritten as number }]],
    ]);
    const accessor = createDataAccessor(store, (id) => overrides.get(id));

    const area = accessor.getPropertySets(7)
      .find((p) => p.name === 'Pset_WallCommon')
      ?.properties.find((p) => p.name === 'MinArea');
    expect(area?.value).toBe(0.9);

    const doc = parseIDS(IDS);
    const report = await validateIDS(doc, accessor, {
      modelId: 'm1',
      schemaVersion: 'IFC4',
      entityCount: 1,
    });
    const spec = report.specificationResults[1];
    expect(spec.status).toBe('pass');
    expect(spec.failedCount).toBe(0);
  });

  it('non-measure control: a label override under the same scaled project is unaffected', async () => {
    const store = await parseIfc(IFC);
    const overrides = new Map<number, PropertyOverride[]>([
      [7, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: 'F90' }]],
    ]);
    const accessor = createDataAccessor(store, (id) => overrides.get(id));

    const fireRating = accessor.getPropertySets(7)
      .find((p) => p.name === 'Pset_WallCommon')
      ?.properties.find((p) => p.name === 'FireRating');
    // A string value must pass through byte-identical — no scale applies
    // to IFCLABEL, and `toBaseSI`/`toRaw` must not coerce it to a number.
    expect(fireRating?.value).toBe('F90');
  });
});
