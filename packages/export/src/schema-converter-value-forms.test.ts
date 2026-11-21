/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10847, as Rust `schema_value_forms_tests.rs`: a value the target slot's type cannot hold. */
import { describe, it, expect } from 'vitest';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';
import { EnumReconciliation } from './schema-converter-enums.js';
import { POSITIONAL } from './schema-value-form-policy.js';
import { getCanonicalEntityName, getSchemaRegistryForVersion } from '@ifc-lite/parser';

const convert = (line: string, from: IfcSchemaVersion, to: IfcSchemaVersion) => {
  const enums = new EnumReconciliation();
  return { out: convertStepLine(line, from, to, undefined, undefined, undefined, undefined, enums), warnings: enums.warnings() };
};

describe('value forms a target slot rejects (#10847)', () => {
  it("drops and names the issue's examples, both ways", () => {
    expect(convert("#5=IFCCLASSIFICATION('src','1',#9,'name');", 'IFC2X3', 'IFC4')).toEqual({
      out: "#5=IFCCLASSIFICATION('src','1',$,'name',$,$,$);",
      warnings: ['1 value(s) of a type the target slot does not accept were dropped: IFCCLASSIFICATION.EditionDate (#10847).'],
    });
    expect(convert("#5=IFCWORKPLAN('g',$,'n',$,$,'id',#9,$,$,10.,2.,#10,$,.ACTUAL.,$);", 'IFC2X3', 'IFC4').out)
      .toBe("#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,'PT10S','PT2S',$,$,.ACTUAL.);");
    expect(convert("#5=IFCRELSEQUENCE('g',$,$,$,#6,#7,2.,.START_START.);", 'IFC2X3', 'IFC4').out)
      .toBe("#5=IFCRELSEQUENCE('g',$,$,$,#6,#7,$,.START_START.,$);");
    expect(convert("#5=IFCCLASSIFICATION('src','1','2020-01-01','name',$,$,$);", 'IFC4', 'IFC2X3').out)
      .toBe("#5=IFCCLASSIFICATION('src','1',$,'name');");
  });

  it('drops a typed value IFC2X3 has no type for, member by member', () => {
    expect(convert("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCBINARY(\"0A\"),$);", 'IFC4X3', 'IFC2X3').out).toBe("#5=IFCPROPERTYSINGLEVALUE('n',$,$,$);");
    expect(convert("#5=IFCPROPERTYLISTVALUE('n',$,(IFCLABEL('a'),IFCBINARY(\"0A\")),$);", 'IFC4X3', 'IFC2X3').out)
      .toBe("#5=IFCPROPERTYLISTVALUE('n',$,(IFCLABEL('a')),$);");
    const kept = "#5=IFCPROPERTYSINGLEVALUE('n',$,IFCLABEL('a') /* c */,$);";
    expect(convert(kept, 'IFC4X3', 'IFC2X3')).toEqual({ out: kept, warnings: [] });
  });

  it('converts what converts without loss', () => {
    expect(convert('#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,0.,1.,#6);', 'IFC4', 'IFC4X3')).toEqual({
      out: '#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(1.),#6);', warnings: [],
    });
    expect(convert('#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,IFCPARAMETERVALUE(0.),IFCLENGTHMEASURE(1.),#6);', 'IFC4X3', 'IFC4').out)
      .toBe('#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,0.,$,#6);');
    expect(convert("#5=IFCQUANTITYCOUNT('n',$,$,3.,$);", 'IFC4', 'IFC4X3').out).toBe("#5=IFCQUANTITYCOUNT('n',$,$,3,$);");
    expect(convert("#5=IFCQUANTITYCOUNT('n',$,$,2.5,$);", 'IFC4', 'IFC4X3').out).toBe("#5=IFCQUANTITYCOUNT('n',$,$,$,$);");
  });

  it('reads past a trailing comment, counts each rejected member once, and names an emptied required slot', () => {
    expect(convert("#5=IFCQUANTITYCOUNT('n',$,$,3. /* c */,$);", 'IFC4', 'IFC4X3').out).toBe("#5=IFCQUANTITYCOUNT('n',$,$,3,$);");
    expect(convert("#5=IFCQUANTITYCOUNT('n',$,$,3 /* see */,$);", 'IFC4', 'IFC4X3').out).toBe("#5=IFCQUANTITYCOUNT('n',$,$,3 /* see */,$);");
    expect(convert('#5=IFCFILLAREASTYLETILES(#1,(#2,#3),1.);', 'IFC2X3', 'IFC4')).toEqual({
      out: '#5=IFCFILLAREASTYLETILES($,$,1.);',
      warnings: ['3 value(s) of a type the target slot does not accept left a slot the target requires as $, so the file is not valid against its header: IFCFILLAREASTYLETILES.Tiles, IFCFILLAREASTYLETILES.TilingPattern (#10847).'],
    });
    expect(convert("#5=IFCQUANTITYCOUNT('n',$,$,2.5,$);", 'IFC4', 'IFC4X3').warnings).toEqual([
      '1 value(s) of a type the target slot does not accept left a slot the target requires as $, so the file is not valid against its header: IFCQUANTITYCOUNT.CountValue (#10847).',
    ]);
  });

  it('reads a real as whole by its digits, not after float rounding (CodeRabbit)', () => {
    const count = (v: string) => convert(`#5=IFCQUANTITYCOUNT('n',$,$,${v},$);`, 'IFC4', 'IFC4X3').out;
    expect(count('2.0000000000000001')).toBe("#5=IFCQUANTITYCOUNT('n',$,$,$,$);");
    expect(count('20.E-1')).toBe("#5=IFCQUANTITYCOUNT('n',$,$,2,$);");
    expect(count('25.E-1')).toBe("#5=IFCQUANTITYCOUNT('n',$,$,$,$);");
    expect(count('3.E2')).toBe("#5=IFCQUANTITYCOUNT('n',$,$,300,$);");
  });

  // Positional members cannot go one by one.
  it('drops positional members whole, with the slots they pair with', () => {
    const table = "#5=IFCPROPERTYTABLEVALUE('t',$,(IFCBINARY(\"0A\"),IFCLABEL('k')),(IFCLABEL('v1'),IFCLABEL('v2')),$,$,$,$);";
    expect(convert(table, 'IFC4', 'IFC2X3')).toEqual({
      out: "#5=IFCPROPERTYTABLEVALUE('t',$,$,$,$,$,$);",
      warnings: ['4 value(s) of a type the target slot does not accept left a slot the target requires as $, so the file is not valid against its header: IFCPROPERTYTABLEVALUE.DefinedValues, IFCPROPERTYTABLEVALUE.DefiningValues (#10847).'],
    });
    // Optional in IFC4, so both go `$` and the record stays valid (WR21: neither, or equal sizes).
    const uri = "#5=IFCPROPERTYTABLEVALUE('t',$,(IFCLABEL('k1'),IFCLABEL('k2')),(IFCLABEL('v'),IFCURIREFERENCE('u')),$,$,$,$);";
    expect(convert(uri, 'IFC4X3', 'IFC4')).toEqual({
      out: "#5=IFCPROPERTYTABLEVALUE('t',$,$,$,$,$,$,$);",
      warnings: ['4 value(s) of a type the target slot does not accept were dropped: IFCPROPERTYTABLEVALUE.DefinedValues, IFCPROPERTYTABLEVALUE.DefiningValues (#10847).'],
    });
    expect(convert("#5=IFCTABLEROW((IFCLABEL('a'),IFCBINARY(\"0A\")),.F.);", 'IFC4', 'IFC2X3').out).toBe('#5=IFCTABLEROW($,.F.);');
    // A non-positional list still loses only the member.
    expect(convert("#5=IFCPROPERTYLISTVALUE('n',$,(IFCLABEL('a'),IFCBINARY(\"0A\")),$);", 'IFC4', 'IFC2X3').out)
      .toBe("#5=IFCPROPERTYLISTVALUE('n',$,(IFCLABEL('a')),$);");
  });

  // /simplify: a misspelled POSITIONAL name would resolve to no slot and silently stop grouping.
  it('names only attributes every schema declares in POSITIONAL', () => {
    for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
      const registry = getSchemaRegistryForVersion(schema);
      for (const [type, groups] of Object.entries(POSITIONAL)) {
        const meta = registry.entities[getCanonicalEntityName(registry, type) ?? ''];
        const names = (meta?.allAttributes ?? meta?.attributes ?? []).map((a) => a.name);
        for (const name of groups.flat()) expect(names, `${schema} ${type}`).toContain(name);
      }
    }
  });

  it('writes a one-member IfcPropertySetDefinitionSet as its member in IFC2X3', () => {
    expect(convert("#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),IFCPROPERTYSETDEFINITIONSET((#9)));", 'IFC4', 'IFC2X3'))
      .toEqual({ out: "#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),#9);", warnings: [] });
    const two = convert("#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),IFCPROPERTYSETDEFINITIONSET((#9,#10)));", 'IFC4X3', 'IFC2X3');
    expect(two.out).toBe("#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),$);");
    // An empty set (already invalid: SET [1:?]) still names the slot it empties.
    const none = convert("#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),IFCPROPERTYSETDEFINITIONSET(()));", 'IFC4', 'IFC2X3');
    expect(none.out).toBe("#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),$);");
    expect(none.warnings.join('\n')).toContain('1 value(s)');
    expect(two.warnings).toEqual(['2 value(s) of a type the target slot does not accept left a slot the target requires as $, so the file is not valid against its header: IFCRELDEFINESBYPROPERTIES.RelatingPropertyDefinition (#10847).']);
  });

  it('writes a required aggregate that may be empty as () when every member is dropped', () => {
    expect(convert("#5=IFCPRESENTATIONLAYERWITHSTYLE('L',$,(#2),$,.T.,.F.,.F.,(IFCNULLSTYLE(.NULL.)));", 'IFC2X3', 'IFC4')).toEqual({
      out: "#5=IFCPRESENTATIONLAYERWITHSTYLE('L',$,(#2),$,.T.,.F.,.F.,());",
      warnings: ['1 value(s) of a type the target slot does not accept were dropped: IFCPRESENTATIONLAYERWITHSTYLE.LayerStyles (#10847).'],
    });
  });

  // Local CodeRabbit on #10878: IFC4X3 made IfcCountMeasure an INTEGER, so a typed count's payload converts too.
  it('writes a whole typed count as an IFC4X3 integer and drops a fractional one', () => {
    expect(convert("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(3.),$);", 'IFC4', 'IFC4X3'))
      .toEqual({ out: "#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(3),$);", warnings: [] });
    expect(convert("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(2.5),$);", 'IFC4', 'IFC4X3')).toEqual({
      out: "#5=IFCPROPERTYSINGLEVALUE('n',$,$,$);",
      warnings: ['1 value(s) of a type the target slot does not accept were dropped: IFCPROPERTYSINGLEVALUE.NominalValue (#10847).'],
    });
    const integral = "#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(3),$);";
    expect(convert(integral, 'IFC4', 'IFC4X3')).toEqual({ out: integral, warnings: [] });
    expect(convert("#5=IFCPROPERTYLISTVALUE('n',$,(IFCCOUNTMEASURE(2.),IFCCOUNTMEASURE(2.5)),$);", 'IFC4', 'IFC4X3')).toEqual({
      out: "#5=IFCPROPERTYLISTVALUE('n',$,(IFCCOUNTMEASURE(2)),$);",
      warnings: ['1 value(s) of a type the target slot does not accept were dropped: IFCPROPERTYLISTVALUE.ListValues (#10847).'],
    });
    // From IFC2X3 too, and a positional member empties its group.
    expect(convert("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(4.),$);", 'IFC2X3', 'IFC4X3').out).toBe("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(4),$);");
    expect(convert("#5=IFCTABLEROW((IFCCOUNTMEASURE(2.5),IFCLABEL('x')),.F.);", 'IFC4', 'IFC4X3').out).toBe('#5=IFCTABLEROW($,.F.);');
    // IFC4X3 -> IFC4 widens IfcCountMeasure back to a number: nothing to convert.
    const integer = "#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(3),$);";
    expect(convert(integer, 'IFC4X3', 'IFC4')).toEqual({ out: integer, warnings: [] });
  });

  it('leaves convertStepLine without a reconciliation object unchanged (callers opt in)', () => {
    expect(convertStepLine("#5=IFCCLASSIFICATION('src','1',#9,'name');", 'IFC2X3', 'IFC4')).toBe("#5=IFCCLASSIFICATION('src','1',#9,'name',$,$,$);");
  });
});

it('keeps the STEP text of newer typed values on downgrade (#10879)', () => {
  const result = convert(`#5=IFCPROPERTYLISTVALUE('n',$,(IFCDATETIME('2026-11-20T10:30:00Z'),IFCURIREFERENCE('https://example.org/a''b'),IFCBINARY("0A")),$);`, 'IFC4X3', 'IFC2X3');
  expect(result.out).toBe("#5=IFCPROPERTYLISTVALUE('n',$,(IFCTEXT('2026-11-20T10:30:00Z'),IFCTEXT('https://example.org/a''b')),$);");
  expect(result.warnings.join(' ')).toContain('1 value(s)');
});

it.each([
  ['PT1.5H', '5400.'], ['PT1H30.5M', '5430.'], ['P0.5D', '43200.'], ['P0.5W', '302400.'],
  ['PT1.5H30M', '$'], ['P0.5DT1H', '$'],
])('converts a fractional duration only on its last unit (#10879): %s', (duration, seconds) => {
  const line = `#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,'${duration}',$,$,$,.ACTUAL.);`;
  expect(convert(line, 'IFC4', 'IFC2X3').out)
    .toBe(`#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,${seconds},$,$,$,.ACTUAL.,$);`);
});

it('converts work control durations in seconds and rejects calendar months (#10879)', () => {
  const up = "#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,12.5,2.E-2,$,$,.ACTUAL.,$);";
  expect(convert(up, 'IFC2X3', 'IFC4').out)
    .toBe("#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,'PT12.5S','PT0.02S',$,$,.ACTUAL.);");
  const down = "#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,'P1DT2H3M4.50S','P1M',$,$,.ACTUAL.);";
  expect(convert(down, 'IFC4X3', 'IFC2X3').out)
    .toBe("#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,93784.5,$,$,$,.ACTUAL.,$);");
});
