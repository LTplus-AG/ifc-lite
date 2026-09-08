/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Proves whether `extractLengthUnitScale` and
 * `extractProjectUnits(...).resolvedForUnitType('LENGTHUNIT')?.siScale` agree
 * on the same project, for `@ifc-lite/ids`'s bridge/units.ts#L135, which
 * currently calls both (`resolvedForUnitType('LENGTHUNIT') !== undefined` to
 * detect "declares a length unit at all", then `extractLengthUnitScale` for
 * the actual scale) rather than reading `siScale` straight off the
 * `ProjectUnits` result it already has.
 *
 * They agree for `IFCSIUNIT` (metres, MILLI-prefixed metres). They DISAGREE
 * for `IFCCONVERSIONBASEDUNIT`: `extractLengthUnitScale` prefers a
 * name-keyed lookup table (`CONVERSION_BASED_UNIT_FACTORS`, unit-extractor.ts)
 * over the file's own declared `ConversionFactor`, while `ProjectUnits`
 * always computes the declared factor
 * (`conversionFactorScale`, project-units.ts). A file that names its unit
 * `'FOOT'` but declares a non-standard `ConversionFactor` - malformed, or a
 * deliberately non-IFC-standard foot variant - gets two different answers
 * from the two resolvers. That disagreement is why bridge/units.ts keeps the
 * second, independent `extractLengthUnitScale` call instead of reading
 * `siScale` off the `ProjectUnits` it already computed.
 */

import { describe, it, expect } from 'vitest';
import { extractLengthUnitScale } from '../src/unit-extractor.js';
import { extractProjectUnits } from '../src/project-units.js';
import type { EntityIndex, EntityRef } from '../src/types.js';

function harness(dataLines: string[]): { source: Uint8Array; entityIndex: EntityIndex } {
  const content = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...dataLines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
  const source = new TextEncoder().encode(content);
  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();
  const re = /^#(\d+)=([A-Z0-9_]+)\(/;
  let offset = 0;
  let lineNumber = 0;
  for (const line of content.split('\n')) {
    lineNumber += 1;
    const m = re.exec(line);
    if (m) {
      const expressId = Number(m[1]);
      const type = m[2];
      const ref: EntityRef = {
        expressId,
        type,
        byteOffset: offset,
        byteLength: line.length,
        lineNumber,
      };
      byId.set(expressId, ref);
      const list = byType.get(type) ?? [];
      list.push(expressId);
      byType.set(type, list);
    }
    offset += line.length + 1;
  }
  return { source, entityIndex: { byId, byType } };
}

const PROJECT = "#1=IFCPROJECT('0001proj',$,'P',$,$,$,$,$,#2);";

function bothScales(dataLines: string[]): { extracted: number; projectUnits: number | undefined } {
  const { source, entityIndex } = harness(dataLines);
  const extracted = extractLengthUnitScale(source, entityIndex);
  const projectUnits = extractProjectUnits(source, entityIndex).resolvedForUnitType('LENGTHUNIT')?.siScale;
  return { extracted, projectUnits };
}

describe('extractLengthUnitScale vs ProjectUnits.resolvedForUnitType(LENGTHUNIT).siScale', () => {
  it('agree for plain SI metres', () => {
    const { extracted, projectUnits } = bothScales([
      PROJECT,
      '#2=IFCUNITASSIGNMENT((#3));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    ]);
    expect(projectUnits).toBe(extracted);
    expect(extracted).toBe(1.0);
  });

  it('agree for MILLI-prefixed SI metres', () => {
    const { extracted, projectUnits } = bothScales([
      PROJECT,
      '#2=IFCUNITASSIGNMENT((#3));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
    ]);
    expect(projectUnits).toBe(extracted);
    expect(extracted).toBeCloseTo(0.001, 10);
  });

  it('agree for a conversion-based FOOT whose declared ConversionFactor matches the table', () => {
    const { extracted, projectUnits } = bothScales([
      PROJECT,
      '#2=IFCUNITASSIGNMENT((#3));',
      "#3=IFCCONVERSIONBASEDUNIT(#4,.LENGTHUNIT.,'FOOT',#5);",
      '#4=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);',
      '#5=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#6);',
      '#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    ]);
    expect(projectUnits).toBeCloseTo(extracted, 10);
    expect(extracted).toBeCloseTo(0.3048, 10);
  });

  it('DISAGREE for a conversion-based unit named FOOT with a non-standard declared ConversionFactor', () => {
    // extractLengthUnitScale resolves 'FOOT' from CONVERSION_BASED_UNIT_FACTORS
    // (a fixed 0.3048) BEFORE looking at the declared factor at all.
    // extractProjectUnits always computes the declared factor. A file that
    // mislabels its unit -- or genuinely uses a non-IFC-standard foot -- gets
    // two different scales from the two resolvers.
    const { extracted, projectUnits } = bothScales([
      PROJECT,
      '#2=IFCUNITASSIGNMENT((#3));',
      "#3=IFCCONVERSIONBASEDUNIT(#4,.LENGTHUNIT.,'FOOT',#5);",
      '#4=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);',
      '#5=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.5),#6);',
      '#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    ]);
    expect(extracted).toBeCloseTo(0.3048, 10); // table wins
    expect(projectUnits).toBeCloseTo(0.5, 10); // declared factor wins
    expect(projectUnits).not.toBe(extracted);
  });
});
