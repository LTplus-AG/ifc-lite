/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { extractProjectUnits, type EntityIndex, type EntityRef, type ProjectUnits } from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import type { ColumnDefinition } from '@ifc-lite/lists';
import { resolveListColumnUnits } from './list-column-units.js';

// Minimal IFC STEP fixtures — mirrors the `indexIfc` helper in display.test.ts
// / project-units.parity.test.ts (issue #1573).
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
    offset += line.length + 1;
  }
  return { source, entityIndex: { byId, byType } };
}

function unitsFromSource(content: string): ProjectUnits {
  const { source, entityIndex } = indexIfc(content);
  return extractProjectUnits(source, entityIndex);
}

// LENGTHUNIT declared in mm, plus a derived VOLUMETRICFLOWRATEUNIT (m³/s) —
// mirrors the fixture in display.test.ts / project-units.parity.test.ts.
const MM_MODEL = unitsFromSource(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('0001projectaaaaaaaaaaa',$,'P',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3,#10));
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCDERIVEDUNITELEMENT(#6,3);
#8=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#9=IFCDERIVEDUNITELEMENT(#8,-1);
#10=IFCDERIVEDUNIT((#7,#9),.VOLUMETRICFLOWRATEUNIT.,$,$);
ENDSEC;
END-ISO-10303-21;
`);

// LENGTHUNIT declared in feet (IfcConversionBasedUnit -> 0.3048 m).
const FT_MODEL = unitsFromSource(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('0001projectbbbbbbbbbbb',$,'P',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));
#3=IFCCONVERSIONBASEDUNIT($,.LENGTHUNIT.,'FOOT',#4);
#4=IFCMEASUREWITHUNIT(0.3048,#5);
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
ENDSEC;
END-ISO-10303-21;
`);

// THERMODYNAMICTEMPERATUREUNIT declared as DEGREE_CELSIUS (an affine unit:
// °C -> K is +273.15, not a pure scale).
const CELSIUS_MODEL = unitsFromSource(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('0001projectccccccccccc',$,'P',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));
#3=IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.DEGREE_CELSIUS.);
ENDSEC;
END-ISO-10303-21;
`);

describe('resolveListColumnUnits (issue #1573 follow-up)', () => {
  it('does not shift a declared-°C column with no override (affine target/source symmetry)', () => {
    // Regression: the target was built as {offset:0} while the source recovered
    // +273.15, so a °C column silently rendered/exported +273.15 with no override.
    const columns: ColumnDefinition[] = [
      { id: 'temp', source: 'property', psetName: 'Pset', propertyName: 'T', dataType: 'IFCTHERMODYNAMICTEMPERATUREMEASURE' },
    ];
    const resolver = resolveListColumnUnits(columns, new Map([['m1', CELSIUS_MODEL]]), {});
    assert.strictEqual(resolver.unitSymbol(0), '°C');
    assert.strictEqual(resolver.convertCell(0, 20, 'm1'), 20); // NOT 293.15
  });

  it('converts declared-°C to K with an override, applying the offset exactly once', () => {
    const columns: ColumnDefinition[] = [
      { id: 'temp', source: 'property', psetName: 'Pset', propertyName: 'T', dataType: 'IFCTHERMODYNAMICTEMPERATUREMEASURE' },
    ];
    const resolver = resolveListColumnUnits(columns, new Map([['m1', CELSIUS_MODEL]]), { THERMODYNAMICTEMPERATUREUNIT: 'k' });
    assert.strictEqual(resolver.unitSymbol(0), 'K');
    assert.ok(Math.abs((resolver.convertCell(0, 20, 'm1') as number) - 293.15) < 1e-9);
  });

  it('is an exact identity (no FP drift) for a non-SI unit with no override', () => {
    // Regression: `v * s / s` is not an FP identity for scale 0.3048, so 877 ft
    // became 876.9999999999999 and leaked into the raw-number XLSX export.
    const columns: ColumnDefinition[] = [
      { id: 'len', source: 'quantity', psetName: 'Qto', propertyName: 'Length', quantityType: QuantityType.Length },
    ];
    const resolver = resolveListColumnUnits(columns, new Map([['ftModel', FT_MODEL]]), {});
    assert.strictEqual(resolver.unitSymbol(0), 'ft');
    assert.strictEqual(resolver.convertCell(0, 877, 'ftModel'), 877); // exact
  });

  it('converts a measure property column (m³/s -> m³/h) with an override', () => {
    const columns: ColumnDefinition[] = [
      { id: 'flow', source: 'property', psetName: 'Pset', propertyName: 'Flow', dataType: 'IFCVOLUMETRICFLOWRATEMEASURE' },
    ];
    const resolver = resolveListColumnUnits(columns, new Map([['m1', MM_MODEL]]), { VOLUMETRICFLOWRATEUNIT: 'm3h' });

    assert.strictEqual(resolver.unitSymbol(0), 'm³/h');
    const converted = resolver.convertCell(0, 0.013888888888888888, 'm1');
    assert.ok(typeof converted === 'number' && Math.abs(converted - 50) < 1e-6);
  });

  it('converts a Length quantity column (mm-model -> m) with an override', () => {
    const columns: ColumnDefinition[] = [
      { id: 'len', source: 'quantity', psetName: 'Qto', propertyName: 'Length', quantityType: QuantityType.Length },
    ];
    const resolver = resolveListColumnUnits(columns, new Map([['m1', MM_MODEL]]), { LENGTHUNIT: 'm' });

    assert.strictEqual(resolver.unitSymbol(0), 'm');
    assert.strictEqual(resolver.convertCell(0, 1000, 'm1'), 1);
  });

  it('federated: mm + ft models, override to m, converts each row from ITS OWN model', () => {
    const columns: ColumnDefinition[] = [
      { id: 'len', source: 'quantity', psetName: 'Qto', propertyName: 'Length', quantityType: QuantityType.Length },
    ];
    const modelUnits = new Map([['mmModel', MM_MODEL], ['ftModel', FT_MODEL]]);
    const resolver = resolveListColumnUnits(columns, modelUnits, { LENGTHUNIT: 'm' });

    assert.strictEqual(resolver.unitSymbol(0), 'm');
    assert.ok(Math.abs((resolver.convertCell(0, 1000, 'mmModel') as number) - 1) < 1e-9);
    assert.ok(Math.abs((resolver.convertCell(0, 1, 'ftModel') as number) - 0.3048) < 1e-9);
  });

  it('passes non-numeric values through unchanged', () => {
    const columns: ColumnDefinition[] = [
      { id: 'len', source: 'quantity', psetName: 'Qto', propertyName: 'Length', quantityType: QuantityType.Length },
    ];
    const resolver = resolveListColumnUnits(columns, new Map([['m1', MM_MODEL]]), { LENGTHUNIT: 'm' });

    assert.strictEqual(resolver.convertCell(0, null, 'm1'), null);
    assert.strictEqual(resolver.convertCell(0, 'n/a', 'm1'), 'n/a');
  });

  it('passes values through unchanged for an unrecognized modelId', () => {
    const columns: ColumnDefinition[] = [
      { id: 'len', source: 'quantity', psetName: 'Qto', propertyName: 'Length', quantityType: QuantityType.Length },
    ];
    const resolver = resolveListColumnUnits(columns, new Map([['m1', MM_MODEL]]), { LENGTHUNIT: 'm' });

    assert.strictEqual(resolver.convertCell(0, 1000, 'unknownModel'), 1000);
  });

  it('with no override, targets the first-contributing model (by modelUnits insertion order) and converts every row into it', () => {
    const columns: ColumnDefinition[] = [
      { id: 'len', source: 'quantity', psetName: 'Qto', propertyName: 'Length', quantityType: QuantityType.Length },
    ];

    const mmFirst = resolveListColumnUnits(columns, new Map([['mmModel', MM_MODEL], ['ftModel', FT_MODEL]]), {});
    assert.strictEqual(mmFirst.unitSymbol(0), 'mm');
    assert.strictEqual(mmFirst.convertCell(0, 1000, 'mmModel'), 1000); // identity: mm -> mm
    assert.ok(Math.abs((mmFirst.convertCell(0, 1, 'ftModel') as number) - 304.8) < 1e-9); // 1 ft -> 304.8 mm

    // Flipping insertion order flips the target — proves it's the Map's
    // order, not a hardcoded "first array element".
    const ftFirst = resolveListColumnUnits(columns, new Map([['ftModel', FT_MODEL], ['mmModel', MM_MODEL]]), {});
    assert.strictEqual(ftFirst.unitSymbol(0), 'ft');
    assert.strictEqual(ftFirst.convertCell(0, 1, 'ftModel'), 1); // identity: ft -> ft
    assert.ok(Math.abs((ftFirst.convertCell(0, 1000, 'mmModel') as number) - 3.280839895013123) < 1e-9); // 1000mm -> ft
  });

  it('unitSymbol returns null for a non-convertible column', () => {
    const columns: ColumnDefinition[] = [{ id: 'name', source: 'attribute', propertyName: 'Name' }];
    const resolver = resolveListColumnUnits(columns, new Map([['m1', MM_MODEL]]), {});
    assert.strictEqual(resolver.unitSymbol(0), null);
    assert.strictEqual(resolver.convertCell(0, 'Wall-01', 'm1'), 'Wall-01');
  });
});
