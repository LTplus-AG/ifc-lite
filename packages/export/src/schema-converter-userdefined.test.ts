/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10780: a `.USERDEFINED.` PredefinedType without its label is reported, as in the Rust twin. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';
import { EnumReconciliation } from './schema-converter-enums.js';
import { EXEMPT, LABELS } from './schema-converter-userdefined.js';

const fixture: { labels: string[]; exempt: Record<string, string[]> } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_userdefined_rules.json', import.meta.url)), 'utf8'),
);

function warned(line: string, from: IfcSchemaVersion, to: IfcSchemaVersion): string[] {
  const enums = new EnumReconciliation();
  convertStepLine(line, from, to, undefined, undefined, undefined, undefined, enums);
  return enums.warnings().filter((w) => w.includes('#10780'));
}

describe('the USERDEFINED rule (#10780)', () => {
  it('is the shared fixture', () => {
    expect(LABELS).toEqual(fixture.labels);
    expect(EXEMPT).toEqual(fixture.exempt);
  });

  it("reports the issue's IfcWorkPlan, written .USERDEFINED. with ObjectType unset", () => {
    const line = "#5=IFCWORKPLAN('g',#2,'P',$,$,'WP-1',#3,(#4),$,$,$,#6,$,.USERDEFINED.,'Custom');";
    expect(warned(line, 'IFC2X3', 'IFC4')).toEqual([expect.stringContaining('1 record(s) are written with PredefinedType .USERDEFINED.')]);
    expect(warned(line, 'IFC2X3', 'IFC4')[0]).toContain('IFCWORKPLAN');
    expect(warned(line.replace("'P',$,$,", "'P',$,'Custom',"), 'IFC2X3', 'IFC4')).toEqual([]);
  });

  it('reports only a type with the rule', () => {
    expect(warned("#5=IFCWALL('g',$,$,$,$,$,$,$,.USERDEFINED.);", 'IFC4X3', 'IFC4')).toHaveLength(1);
    expect(warned("#5=IFCWALL('g',$,$,$,'Mine',$,$,$,.USERDEFINED.);", 'IFC4X3', 'IFC4')).toEqual([]);
    expect(warned("#5=IFCWALL('g',$,$,$,$,$,$,$,.STANDARD.);", 'IFC4X3', 'IFC4')).toEqual([]);
    expect(warned("#5=IFCDOOR('g',$,$,$,$,$,$,$,$,$,.USERDEFINED.,$,$);", 'IFC4X3', 'IFC4')).toEqual([]);
  });
});
