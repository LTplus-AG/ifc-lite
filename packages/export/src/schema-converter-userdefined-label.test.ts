/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10824: a `.USERDEFINED.` label carried through ObjectType, as the Rust twin does. Reached through convertStepLine. */
import { describe, it, expect } from 'vitest';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';
import { EnumReconciliation } from './schema-converter-enums.js';

const up = (line: string, to: IfcSchemaVersion = 'IFC4') => convertStepLine(line, 'IFC2X3', to);
const down = (line: string, from: IfcSchemaVersion = 'IFC4') => convertStepLine(line, from, 'IFC2X3');

describe('the .USERDEFINED. label (#10824)', () => {
  it('writes the IFC2X3 label into an unset ObjectType on an upgrade', () => {
    for (const to of ['IFC4', 'IFC4X3'] as const) {
      expect(up("#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.USERDEFINED.,'Custom');", to))
        .toBe("#7=IFCWORKPLAN('g',#2,'P',$,'Custom','WP',$,$,$,$,$,$,$,.USERDEFINED.);");
      expect(up("#7=IFCPROCEDURE('g',#2,'P',$,$,'P-1',.USERDEFINED.,'Flush');", to))
        .toBe("#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',$,.USERDEFINED.);");
      expect(up("#7=IFCELECTRICDISTRIBUTIONPOINT('g',#2,'n',$,$,$,$,'t',.USERDEFINED.,'Custom');", to))
        .toBe("#7=IFCELECTRICDISTRIBUTIONBOARD('g',#2,'n',$,'Custom',$,$,'t',.USERDEFINED.);");
    }
  });

  it('reads a source record without its terminator, as convertRecord does', () => {
    expect(up("#7=IFCPROCEDURE('g',#2,'P',$,$,'P-1',.USERDEFINED.,'Flush')")).toBe("#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',$,.USERDEFINED.);");
  });

  it('reads a commented $ as unset and a trailing comment after the terminator', () => {
    expect(up("#7=IFCPROCEDURE('g',#2,'P',$,/* unset */$,'P-1',.USERDEFINED.,'Flush'); /* tail */")).toBe("#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',$,.USERDEFINED.);");
  });

  it('keeps a set ObjectType, and carries nothing for another member', () => {
    expect(up("#7=IFCWORKPLAN('g',#2,'P',$,'Mine','WP',$,$,$,$,$,$,$,.USERDEFINED.,'Custom');"))
      .toBe("#7=IFCWORKPLAN('g',#2,'P',$,'Mine','WP',$,$,$,$,$,$,$,.USERDEFINED.);");
    expect(up("#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.ACTUAL.,'Custom');"))
      .toBe("#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.ACTUAL.);");
  });

  it('writes ObjectType into the unset IFC2X3 label on a downgrade', () => {
    for (const from of ['IFC4', 'IFC4X3'] as const) {
      expect(down("#7=IFCWORKPLAN('g',#2,'P',$,'Custom','WP',$,$,$,$,$,$,$,.USERDEFINED.);", from))
        .toBe("#7=IFCWORKPLAN('g',#2,'P',$,'Custom','WP',$,$,$,$,$,$,$,.USERDEFINED.,'Custom');");
      expect(down("#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',$,.USERDEFINED.);", from))
        .toBe("#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',.USERDEFINED.,'Flush');");
    }
    expect(down("#7=IFCELECTRICDISTRIBUTIONBOARD('g',#2,'n',$,'Custom',$,$,'t',.USERDEFINED.);"))
      .toBe("#7=IFCELECTRICDISTRIBUTIONPOINT('g',#2,'n',$,'Custom',$,$,'t',.USERDEFINED.,'Custom');");
    expect(down("#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',$,.SHUTDOWN.);")).toBe("#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',.SHUTDOWN.,$);");
  });

  it('reconciles a point or board member the target lacks, as Rust does (#10856)', () => {
    const run = (line: string, from: IfcSchemaVersion, to: IfcSchemaVersion) => {
      const enums = new EnumReconciliation();
      return { out: convertStepLine(line, from, to, undefined, undefined, undefined, undefined, enums), warnings: enums.warnings() };
    };
    for (const to of ['IFC4', 'IFC4X3'] as const) {
      expect(run("#7=IFCELECTRICDISTRIBUTIONPOINT('g',#2,'n',$,$,$,$,'t',.ALARMPANEL.,$);", 'IFC2X3', to).out, to)
        .toBe("#7=IFCELECTRICDISTRIBUTIONBOARD('g',#2,'n',$,'ALARMPANEL',$,$,'t',.USERDEFINED.);");
    }
    const down = run("#7=IFCELECTRICDISTRIBUTIONBOARD('g',#2,'n',$,$,$,$,'t',.DISPATCHINGBOARD.);", 'IFC4X3', 'IFC2X3');
    expect(down.out).toBe("#7=IFCELECTRICDISTRIBUTIONPOINT('g',#2,'n',$,$,$,$,'t',.NOTDEFINED.,$);");
    expect(down.warnings.join('\n')).toContain('IFCELECTRICDISTRIBUTIONPOINT.DistributionPointFunction .DISPATCHINGBOARD.');
  });
});
