/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A numeric property is written as the measure type it declares.
 *
 * Every number used to come out as IFCINTEGER or IFCREAL whatever `Type` said,
 * so Pset_WallCommon.ThermalTransmittance declared an
 * IfcThermalTransmittanceMeasure was written `IFCREAL(0.25)` and an IDS
 * data-type check against the standard property set failed on a file the
 * caller had typed correctly.
 */

import { describe, it, expect } from 'vitest';
import { IfcCreator } from './ifc-creator.js';

function propertyLines(properties: Parameters<IfcCreator['addIfcPropertySet']>[1]['Properties']): string {
  const creator = new IfcCreator();
  const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  const wall = creator.addIfcWall(storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
  creator.addIfcPropertySet(wall, { Name: 'Pset_WallCommon', Properties: properties });
  return creator.toIfc().content
    .split('\n')
    .filter((line) => line.includes('IFCPROPERTYSINGLEVALUE'))
    .join('\n');
}

describe('numeric property values keep their declared measure type', () => {
  it('writes a declared measure type rather than IFCREAL', () => {
    const lines = propertyLines([
      { Name: 'ThermalTransmittance', NominalValue: 0.25, Type: 'IfcThermalTransmittanceMeasure' },
      { Name: 'Span', NominalValue: 5, Type: 'IfcPositiveLengthMeasure' },
      { Name: 'Slope', NominalValue: 0.5, Type: 'IfcPlaneAngleMeasure' },
    ]);
    expect(lines).toContain("'ThermalTransmittance',$,IFCTHERMALTRANSMITTANCEMEASURE(0.25),$)");
    // A whole length is still a REAL, so it keeps its decimal point.
    expect(lines).toContain("'Span',$,IFCPOSITIVELENGTHMEASURE(5.),$)");
    expect(lines).toContain("'Slope',$,IFCPLANEANGLEMEASURE(0.5),$)");
    expect(lines).not.toContain('IFCREAL');
  });

  it('writes a whole count as an integer literal', () => {
    const lines = propertyLines([{ Name: 'NumberOfRiser', NominalValue: 12, Type: 'IfcCountMeasure' }]);
    expect(lines).toContain("'NumberOfRiser',$,IFCCOUNTMEASURE(12),$)");
  });

  it('keeps the untyped defaults', () => {
    const lines = propertyLines([
      { Name: 'Whole', NominalValue: 3 },
      { Name: 'Fraction', NominalValue: 0.25 },
      { Name: 'ExplicitReal', NominalValue: 2, Type: 'IfcReal' },
    ]);
    expect(lines).toContain("'Whole',$,IFCINTEGER(3),$)");
    expect(lines).toContain("'Fraction',$,IFCREAL(0.25),$)");
    expect(lines).toContain("'ExplicitReal',$,IFCREAL(2.),$)");
  });

  it('refuses a type name that would corrupt the STEP line', () => {
    // Untyped callers (the sandbox, JSON) can pass any string here.
    expect(() => propertyLines([
      { Name: 'Bad', NominalValue: 1, Type: "IfcLengthMeasure(1));#9=IFCWALL('x" as 'IfcLengthMeasure' },
    ])).toThrow(/Invalid property value type/);
  });
});
