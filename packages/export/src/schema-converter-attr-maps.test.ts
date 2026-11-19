/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10763: the reviewed attribute maps, held to the table the Rust twin also compares. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attrNameTable, convertStepLine } from './schema-converter.js';
import { getAttrMaps } from './schema-converter-attr-maps.js';
import { Ifc4SlotCheck } from './schema-converter-ifc4-slots.js';
import { classifyEntityTypeConversion } from './schema-conversion-loss-report.js';

const fixture: { maps: unknown[] } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_attribute_maps.json', import.meta.url)), 'utf8'),
);

describe('attribute maps (#10763)', () => {
  it('is the shared fixture, entry for entry', () => {
    const maps = getAttrMaps();
    expect(getAttrMaps()).toBe(maps);
    expect(maps.length).toBeGreaterThanOrEqual(20);
    const strip = (m: object) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'why'));
    expect(maps.map(strip)).toEqual(fixture.maps.map((m) => strip(m as object)));
  });

  it('names real attributes, and IFC4X3 declares the IFC4 list', () => {
    for (const m of getAttrMaps()) {
      const old = attrNameTable('IFC2X3')!.get(m.ifc2x3)!;
      const next = attrNameTable('IFC4')!.get(m.ifc4)!;
      expect(attrNameTable('IFC4X3')!.get(m.ifc4), m.ifc4).toEqual(next);
      for (const [a, b] of [...m.renamed, ...(m.setOfOne ? [m.setOfOne] : [])]) {
        expect(old.includes(a) && next.includes(b), `${m.ifc4}: ${a} -> ${b}`).toBe(true);
      }
      for (const name of [...m.retyped, ...m.upOnly]) expect(old.includes(name) && next.includes(name), name).toBe(true);
    }
  });

  it("carries the issue's IfcApproval values to their own slots, both ways", () => {
    expect(convertStepLine("#5=IFCAPPROVAL('desc',#9,'Approved','L1','Q','Name','Id');", 'IFC2X3', 'IFC4'))
      .toBe("#5=IFCAPPROVAL('Id','Name','desc',$,'Approved','L1','Q',$,$);");
    expect(convertStepLine("#5=IFCAPPROVAL('Id','Name','desc','2020-01-01','Approved','L1','Q',#7,#8);", 'IFC4', 'IFC2X3'))
      .toBe("#5=IFCAPPROVAL('desc',$,'Approved','L1','Q','Name','Id');");
  });

  it('wraps a single reference into a SET and keeps the first member on the way down', () => {
    expect(convertStepLine("#5=IFCAPPROVALRELATIONSHIP(#3,#4,'d','n');", 'IFC2X3', 'IFC4')).toBe("#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3));");
    expect(convertStepLine("#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3,#6));", 'IFC4', 'IFC2X3')).toBe("#5=IFCAPPROVALRELATIONSHIP(#3,#4,'d','n');");
  });

  it('reads a slot holding only a comment and $ as no value (#10779)', () => {
    expect(convertStepLine("#5=IFCAPPROVAL(/* none */$,#9,$,$,$,'Name','Id');", 'IFC2X3', 'IFC4'))
      .toBe("#5=IFCAPPROVAL('Id','Name',$,$,$,$,$,$,$);");
  });

  it('drops comments around a SET when it is rebuilt, as Rust does', () => {
    const down = (attrs: string) => convertStepLine(`#5=IFCAPPROVALRELATIONSHIP(${attrs});`, 'IFC4', 'IFC2X3');
    const up = (attrs: string) => convertStepLine(`#5=IFCAPPROVALRELATIONSHIP(${attrs});`, 'IFC2X3', 'IFC4');
    expect(down("'n','d',#4,/* a */(#3,#6)/* b */")).toBe("#5=IFCAPPROVALRELATIONSHIP(#3,#4,'d','n');");
    expect(down("'n','d',#4,(/* c */$,#6)")).toBe("#5=IFCAPPROVALRELATIONSHIP(#6,#4,'d','n');");
    expect(up("/* c */(#3),#4,'d','n'")).toBe("#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3));");
    expect(up("#3 /* x */,#4,'d','n'")).toBe("#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3));");
  });

  it('downgrades IFC4 profile properties to the IFC2X3 subtype IFC4 deleted', () => {
    expect(convertStepLine("#5=IFCPROFILEPROPERTIES('n',$,(#6),#8);", 'IFC4X3', 'IFC2X3')).toBe('#5=IFCGENERALPROFILEPROPERTIES($,#8,$,$,$,$,$);');
    expect(classifyEntityTypeConversion('IFCPROFILEPROPERTIES', 'IFC4', 'IFC2X3')).toEqual({
      targetType: 'IFCGENERALPROFILEPROPERTIES', kind: 'lossy', droppedAttributes: ['Name', 'Description', 'Properties'],
    });
  });

  it('upgrades the IFC2X3 property subtypes IFC4 deleted to the IFC4 supertype, naming every dropped measure (#10777)', () => {
    expect(convertStepLine("#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6,#7),'d','Pset_x');", 'IFC2X3', 'IFC4'))
      .toBe("#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6,#7),#8);");
    expect(convertStepLine('#5=IFCMECHANICALMATERIALPROPERTIES(#8,$,2.1E11,8.1E10,0.3,1.2E-5);', 'IFC2X3', 'IFC4'))
      .toBe('#5=IFCMATERIALPROPERTIES($,$,$,#8);');
    expect(classifyEntityTypeConversion('IFCMECHANICALMATERIALPROPERTIES', 'IFC2X3', 'IFC4')).toEqual({
      targetType: 'IFCMATERIALPROPERTIES', kind: 'lossy',
      droppedAttributes: ['DynamicViscosity', 'YoungModulus', 'ShearModulus', 'PoissonRatio', 'ThermalExpansionCoefficient'],
    });
    expect(classifyEntityTypeConversion('IFCRIBPLATEPROFILEPROPERTIES', 'IFC2X3', 'IFC4X3').droppedAttributes)
      .toEqual(['ProfileName', 'Thickness', 'RibHeight', 'RibWidth', 'RibSpacing', 'Direction']);
  });

  it('drops an up-only reference on the way down and reports it', () => {
    expect(convertStepLine("#5=IFCLIBRARYINFORMATION('n','v',#3,'2020-01-01','https://x',$);", 'IFC4', 'IFC2X3'))
      .toBe("#5=IFCLIBRARYINFORMATION('n','v',$,$,$);");
    expect(classifyEntityTypeConversion('IFCLIBRARYINFORMATION', 'IFC4', 'IFC2X3').droppedAttributes)
      .toEqual(['Publisher', 'VersionDate', 'Location', 'Description']);
  });

  it('counts an IFC4-required slot a mapped upgrade cannot fill', () => {
    const slots = new Ifc4SlotCheck();
    expect(convertStepLine('#5=IFCTEXTUREMAP((#6));', 'IFC2X3', 'IFC4', undefined, undefined, undefined, slots)).toBe('#5=IFCTEXTUREMAP($,$,$);');
    expect(slots.warnings()).toEqual([expect.stringMatching(/^3 slot\(s\) keep \$ where IFC4 requires/)]);
  });
});
