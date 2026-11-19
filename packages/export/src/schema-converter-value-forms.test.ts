/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10847, as Rust `schema_value_forms_tests.rs`: a value the target slot's type cannot hold. */
import { describe, it, expect } from 'vitest';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';
import { EnumReconciliation } from './schema-converter-enums.js';

const convert = (line: string, from: IfcSchemaVersion, to: IfcSchemaVersion) => {
  const enums = new EnumReconciliation();
  return { out: convertStepLine(line, from, to, undefined, undefined, undefined, undefined, enums), warnings: enums.warnings() };
};

describe('value forms a target slot rejects (#10847)', () => {
  it("drops and names the issue's examples, both ways", () => {
    expect(convert("#5=IFCCLASSIFICATION('src','1',#9,'name');", 'IFC2X3', 'IFC4')).toEqual({
      out: "#5=IFCCLASSIFICATION('src','1',$,'name',$,$,$);",
      warnings: ['1 value(s) of a type the target slot does not accept were written as $: IFCCLASSIFICATION.EditionDate (#10847).'],
    });
    expect(convert("#5=IFCWORKPLAN('g',$,'n',$,$,'id',#9,$,$,10.,2.,#10,$,.ACTUAL.);", 'IFC2X3', 'IFC4').out)
      .toBe("#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,$,$,$,$,.ACTUAL.);");
    expect(convert("#5=IFCRELSEQUENCE('g',$,$,$,#6,#7,2.,.START_START.);", 'IFC2X3', 'IFC4').out)
      .toBe("#5=IFCRELSEQUENCE('g',$,$,$,#6,#7,$,.START_START.,$);");
    expect(convert("#5=IFCCLASSIFICATION('src','1','2020-01-01','name',$,$,$);", 'IFC4', 'IFC2X3').out)
      .toBe("#5=IFCCLASSIFICATION('src','1',$,'name');");
  });

  it('drops a typed value IFC2X3 has no type for, member by member', () => {
    expect(convert("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCDATE('2020-01-01'),$);", 'IFC4X3', 'IFC2X3').out).toBe("#5=IFCPROPERTYSINGLEVALUE('n',$,$,$);");
    expect(convert("#5=IFCPROPERTYLISTVALUE('n',$,(IFCLABEL('a'),IFCDATE('2020-01-01')),$);", 'IFC4X3', 'IFC2X3').out)
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

  it('leaves convertStepLine without a reconciliation object unchanged (callers opt in)', () => {
    expect(convertStepLine("#5=IFCCLASSIFICATION('src','1',#9,'name');", 'IFC2X3', 'IFC4')).toBe("#5=IFCCLASSIFICATION('src','1',#9,'name',$,$,$);");
  });
});
