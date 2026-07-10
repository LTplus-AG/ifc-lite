/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { extractProjectUnits, ProjectUnits, type EntityIndex, type EntityRef } from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import { formatMeasureUnit, formatQuantityUnit, QUANTITY_TYPE_UNIT, resolveMeasureDisplay, resolveQuantityDisplay, formatConverted } from './display.js';

// A minimal IFC4X3 unit assignment: length declared in mm, plus a derived
// VOLUMETRICFLOWRATEUNIT (m³/s) - mirrors the shared parity fixture case
// `vzt_like_mm_area_volume_derived_flowrate` in
// rust/core/tests/fixtures/unit_symbol_vectors.json (issue #1573).
const IFC_SOURCE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('0001projectaaaaaaaaaaa',$,'P',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3,#4,#5,#10));
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#4=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#5=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCDERIVEDUNITELEMENT(#6,3);
#8=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#9=IFCDERIVEDUNITELEMENT(#8,-1);
#10=IFCDERIVEDUNIT((#7,#9),.VOLUMETRICFLOWRATEUNIT.,$,$);
ENDSEC;
END-ISO-10303-21;
`;

/** Build source bytes + a minimal EntityIndex over a complete IFC STEP file
 *  string. Mirrors `indexIfc` in project-units.parity.test.ts. */
function indexIfc(content: string): { source: Uint8Array; entityIndex: EntityIndex } {
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
      byId.set(expressId, { expressId, type, byteOffset: offset, byteLength: line.length, lineNumber });
      const list = byType.get(type) ?? [];
      list.push(expressId);
      byType.set(type, list);
    }
    offset += line.length + 1; // +1 for '\n'
  }
  return { source, entityIndex: { byId, byType } };
}

describe('formatMeasureUnit', () => {
  it('resolves a flow-rate dataType against the file\'s declared derived unit', () => {
    const { source, entityIndex } = indexIfc(IFC_SOURCE);
    const units = extractProjectUnits(source, entityIndex);
    assert.strictEqual(formatMeasureUnit('IFCVOLUMETRICFLOWRATEMEASURE', units), 'm³/s');
  });

  it('is case-insensitive and accepts the bare (no IFC prefix) measure name', () => {
    const { source, entityIndex } = indexIfc(IFC_SOURCE);
    const units = extractProjectUnits(source, entityIndex);
    assert.strictEqual(formatMeasureUnit('volumetricflowratemeasure', units), 'm³/s');
  });

  it('returns null for a dimensionless measure (ratio) even with declared units', () => {
    const { source, entityIndex } = indexIfc(IFC_SOURCE);
    const units = extractProjectUnits(source, entityIndex);
    assert.strictEqual(formatMeasureUnit('IFCRATIOMEASURE', units), null);
  });

  it('returns null when dataType is undefined', () => {
    assert.strictEqual(formatMeasureUnit(undefined, ProjectUnits.empty()), null);
  });

  it('falls back to the SI default symbol when the file declares nothing', () => {
    assert.strictEqual(formatMeasureUnit('IFCVOLUMETRICFLOWRATEMEASURE', ProjectUnits.empty()), 'm³/s');
  });
});

describe('formatQuantityUnit', () => {
  it('resolves a Length quantity against the file\'s mm-declared unit', () => {
    const { source, entityIndex } = indexIfc(IFC_SOURCE);
    const units = extractProjectUnits(source, entityIndex);
    assert.strictEqual(formatQuantityUnit(QuantityType.Length, units), 'mm');
  });

  it('falls back to the SI default ("m") when no length unit is declared', () => {
    assert.strictEqual(formatQuantityUnit(QuantityType.Length, ProjectUnits.empty()), 'm');
  });

  it('returns null for Count regardless of declared units', () => {
    const { source, entityIndex } = indexIfc(IFC_SOURCE);
    const units = extractProjectUnits(source, entityIndex);
    assert.strictEqual(formatQuantityUnit(QuantityType.Count, units), null);
    assert.strictEqual(QUANTITY_TYPE_UNIT[QuantityType.Count], null);
  });

  it('returns the SI default for an unrecognized quantity type', () => {
    assert.strictEqual(formatQuantityUnit(999, ProjectUnits.empty()), null);
  });
});

describe('resolveMeasureDisplay', () => {
  it('converts a flow-rate value into the overridden unit (m³/s -> m³/h)', () => {
    const { source, entityIndex } = indexIfc(IFC_SOURCE);
    const units = extractProjectUnits(source, entityIndex);
    const disp = resolveMeasureDisplay(0.013888888888888888, 'IFCVOLUMETRICFLOWRATEMEASURE', units, { VOLUMETRICFLOWRATEUNIT: 'm3h' });
    assert.strictEqual(disp.unit, 'm³/h');
    assert.ok(disp.converted !== null && Math.abs(disp.converted - 50) < 1e-6);
  });

  it('leaves the value unconverted (mm stays mm) when there is no override for that unit type', () => {
    const { source, entityIndex } = indexIfc(IFC_SOURCE);
    const units = extractProjectUnits(source, entityIndex);
    // LENGTHUNIT has no override in this map.
    const disp = resolveMeasureDisplay(3000, 'IFCLENGTHMEASURE', units, { VOLUMETRICFLOWRATEUNIT: 'm3h' });
    assert.strictEqual(disp.unit, 'mm');
    assert.strictEqual(disp.converted, null);
  });

  it('adds the offset when overriding a temperature measure to Kelvin', () => {
    const disp = resolveMeasureDisplay(0, 'IFCTHERMODYNAMICTEMPERATUREMEASURE', ProjectUnits.empty(), { THERMODYNAMICTEMPERATUREUNIT: 'k' });
    // The file default for THERMODYNAMICTEMPERATUREMEASURE is K, and ProjectUnits.empty()
    // resolves an unrecognized unit-type to the SI default with no offset, so the
    // "file unit" here IS Kelvin - override to Celsius instead to see a real conversion.
    assert.strictEqual(disp.converted, 0);

    const toCelsius = resolveMeasureDisplay(0, 'IFCTHERMODYNAMICTEMPERATUREMEASURE', ProjectUnits.empty(), { THERMODYNAMICTEMPERATUREUNIT: 'c' });
    assert.strictEqual(toCelsius.unit, '°C');
    assert.ok(toCelsius.converted !== null && Math.abs(toCelsius.converted - -273.15) < 1e-9);
  });

  it('never converts a dimensionless measure even with a matching override key', () => {
    const disp = resolveMeasureDisplay(0.5, 'IFCRATIOMEASURE', ProjectUnits.empty(), { LENGTHUNIT: 'mm' });
    assert.strictEqual(disp.unit, null);
    assert.strictEqual(disp.converted, null);
  });

  it('does not convert a non-finite / non-numeric value', () => {
    const disp = resolveMeasureDisplay('not a number', 'IFCLENGTHMEASURE', ProjectUnits.empty(), { LENGTHUNIT: 'mm' });
    assert.strictEqual(disp.converted, null);
  });
});

describe('resolveQuantityDisplay', () => {
  it('resolves the file\'s mm-declared unit unconverted when there is no override', () => {
    const { source, entityIndex } = indexIfc(IFC_SOURCE);
    const units = extractProjectUnits(source, entityIndex);
    const disp = resolveQuantityDisplay(3000, QuantityType.Length, units, {});
    assert.strictEqual(disp.unit, 'mm');
    assert.strictEqual(disp.converted, null);
  });

  it('converts a length quantity into an overridden unit (mm -> m)', () => {
    const { source, entityIndex } = indexIfc(IFC_SOURCE);
    const units = extractProjectUnits(source, entityIndex);
    const disp = resolveQuantityDisplay(3000, QuantityType.Length, units, { LENGTHUNIT: 'm' });
    assert.strictEqual(disp.unit, 'm');
    assert.ok(disp.converted !== null && Math.abs(disp.converted - 3) < 1e-9);
  });

  it('returns no unit/conversion for Count', () => {
    const disp = resolveQuantityDisplay(5, QuantityType.Count, ProjectUnits.empty(), { LENGTHUNIT: 'mm' });
    assert.strictEqual(disp.unit, null);
    assert.strictEqual(disp.converted, null);
  });
});

describe('formatConverted', () => {
  it('formats with up to 4 fraction digits', () => {
    assert.strictEqual(formatConverted(50), '50');
    assert.strictEqual(formatConverted(1 / 3), '0.3333');
  });
});
