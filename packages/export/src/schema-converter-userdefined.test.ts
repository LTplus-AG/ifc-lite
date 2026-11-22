/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10780: a `.USERDEFINED.` PredefinedType without its label is reported, as in
 * the Rust twin. Reached through `EnumReconciliation` and `convertStepLine`,
 * and held to the shared fixture by behaviour, entity by entity.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attrNameTable, convertStepLine, type IfcSchemaVersion } from './schema-converter.js';
import { EnumReconciliation } from './schema-converter-enums.js';

const fixture: { labels: string[]; exempt: Record<'IFC2X3' | 'IFC4' | 'IFC4X3', string[]> } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_userdefined_rules.json', import.meta.url)), 'utf8'),
);

const reported = (enums: EnumReconciliation) => enums.warnings().filter((w) => w.includes('#10780'));

function warned(line: string, from: IfcSchemaVersion, to: IfcSchemaVersion): string[] {
  const enums = new EnumReconciliation();
  convertStepLine(line, from, to, undefined, undefined, undefined, undefined, enums);
  return reported(enums);
}

describe('the USERDEFINED rule (#10780)', () => {
  it('reports exactly the entities the shared fixture does not exempt, in every schema', () => {
    for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
      const exempt = new Set(fixture.exempt[schema]);
      // What `EXEMPT_AT` must hold for this registry, named in every failure below.
      const candidates = [...attrNameTable(schema)!].filter(([, n]) => n.includes('PredefinedType') && n.some((a) => fixture.labels.includes(a))).map(([t]) => t).sort();
      const encoding = fixture.exempt[schema].map((t) => candidates.indexOf(t).toString(36)).join(' ');
      let checked = 0;
      for (const [type, names] of attrNameTable(schema)!) {
        const predefined = names.indexOf('PredefinedType');
        const label = names.findIndex((n) => fixture.labels.includes(n));
        if (predefined < 0 || label < 0) continue;
        const slots = names.map((_, i) => (i === 0 ? "'g'" : i === predefined ? '.USERDEFINED.' : '$'));
        const enums = new EnumReconciliation();
        enums.apply(`#5=${type}(${slots.join(',')});`, schema);
        expect(reported(enums).length, `${schema} ${type}; EXEMPT_AT.${schema} = '${encoding}'`).toBe(exempt.has(type) ? 0 : 1);
        checked++;
      }
      expect(checked, `anti-vacuity: ${schema}`).toBeGreaterThan(80);
    }
  });

  it("reports the issue's IfcWorkPlan, written .USERDEFINED. with ObjectType unset", () => {
    // With no IFC2X3 label either: #10824 carries a set UserDefinedControlType into ObjectType, so that one is not reported.
    const line = "#5=IFCWORKPLAN('g',#2,'P',$,$,'WP-1',#3,(#4),$,$,$,#6,$,.USERDEFINED.,$);";
    expect(warned(line, 'IFC2X3', 'IFC4')).toEqual([expect.stringContaining('1 record(s) say .USERDEFINED. without the label')]);
    expect(warned(line, 'IFC2X3', 'IFC4')[0]).toContain('IFCWORKPLAN');
    expect(warned(line.replace("'P',$,$,", "'P',$,'Custom',"), 'IFC2X3', 'IFC4')).toEqual([]);
    expect(warned(line.replace('.USERDEFINED.,$);', ".USERDEFINED.,'Custom');"), 'IFC2X3', 'IFC4'), 'the IFC2X3 label is carried (#10824)').toEqual([]);
  });

  it('reports only a type with the rule', () => {
    expect(warned("#5=IFCWALL('g',$,$,$,$,$,$,$,.USERDEFINED.);", 'IFC4X3', 'IFC4')).toHaveLength(1);
    expect(warned("#5=IFCWALL('g',$,$,$,'Mine',$,$,$,.USERDEFINED.);", 'IFC4X3', 'IFC4')).toEqual([]);
    expect(warned("#5=IFCWALL('g',$,$,$,$,$,$,$,.STANDARD.);", 'IFC4X3', 'IFC4')).toEqual([]);
    expect(warned("#5=IFCDOOR('g',$,$,$,$,$,$,$,$,$,.USERDEFINED.,$,$);", 'IFC4X3', 'IFC4')).toEqual([]);
    expect(warned("#5=IFCWALL('g',$,$,$,/* none */$,$,$,$,.USERDEFINED. /* x */);", 'IFC4X3', 'IFC4'), 'comments are trivia').toHaveLength(1);
  });
});

describe('IFC2X3 user-defined enum and label pairs (#11006)', () => {
  for (const [type, source] of [
    ['IFCWORKPLAN', "#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.USERDEFINED.);"],
    ['IFCWORKSCHEDULE', "#7=IFCWORKSCHEDULE('g',#2,'S',$,$,'WS',$,$,$,$,$,$,$,.USERDEFINED.);"],
    ['IFCPROCEDURE', "#7=IFCPROCEDURE('g',#2,'P',$,$,'P-1',$,.USERDEFINED.);"],
    ['IFCELECTRICDISTRIBUTIONPOINT', "#7=IFCELECTRICDISTRIBUTIONBOARD('g',#2,'b',$,$,$,$,'t',.USERDEFINED.);"],
  ]) {
    it(`reports the unset label for ${type}`, () => {
      expect(warned(source, 'IFC4', 'IFC2X3')).toContainEqual(expect.stringContaining(type));
      expect(warned(source.replace("',$,$,", "',$,'Custom',"), 'IFC4', 'IFC2X3'))
        .not.toContainEqual(expect.stringContaining('without the label their rule needs'));
    });
  }
  it('reports a star beside a comment as an unset label', () => {
    const source = "#7=IFCSLAB('g',#2,$,$,/* unset */*,$,$,$,.USERDEFINED.);";
    expect(warned(source, 'IFC4X3', 'IFC4')).toContainEqual(expect.stringContaining('IFCSLAB'));
  });
  it('uses UserDefinedControlType for an unrecognized WorkControlType', () => {
    const source = "#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.CUSTOMPLAN.);";
    const checks = new EnumReconciliation();
    expect(convertStepLine(source, 'IFC4', 'IFC2X3', undefined, undefined, undefined, undefined, checks))
      .toMatch(/,\.USERDEFINED\.,'CUSTOMPLAN'\);$/);
    expect(checks.warnings()).not.toContainEqual(expect.stringContaining('without the label their rule needs'));
  });
  it.each(['$', '*'])('fills UserDefinedControlType when a comment precedes %s (#11006)', (unset) => {
    const source = `#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.CUSTOMPLAN.,/* unset */${unset});`;
    const checks = new EnumReconciliation();
    expect(checks.apply(source, 'IFC2X3')).toMatch(/,\.USERDEFINED\.,'CUSTOMPLAN'\);$/);
    expect(checks.warnings()).toEqual([]);
  });
});
