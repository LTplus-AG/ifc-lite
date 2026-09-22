/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { convertStepLine } from './schema-converter.js';
import { Ifc4SlotFill } from './schema-converter-ifc4-slots.js';

// #5202 finding 2: cardinality tightening on a downgrade to IFC4 was
// entirely unguarded (only `toSchema === 'IFC2X3'` had a fill/count
// mechanism). `IfcProjectedCRS.Name` is optional in IFC4X3 and mandatory in
// IFC4, at position 0 — a valid IFC4X3 record legitimately carries `$` there.

describe('schema-converter: IFC4-target required slots (#5202)', () => {
  it('the exact IfcProjectedCRS conversion from the issue: Name stays $ but is now COUNTED', () => {
    const line = "#10=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);";
    const slots = new Ifc4SlotFill();
    const result = convertStepLine(line, 'IFC4X3', 'IFC4', undefined, undefined, undefined, slots);
    // Name (IfcLabel) has no honest default — this table never invents one —
    // so the emitted text is byte-identical to the input, exactly like the
    // issue's own executed OUT. The record is still not valid IFC4; the
    // caller now has a way to find out.
    expect(result).toBe("#10=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);");
    expect(slots.warnings()).toEqual([
      "1 slot(s) keep $ where IFC4 requires a value and the schema offers no default that claims " +
      'nothing (measures, labels, identifiers, references, and every enum); the file is not valid IFC4 (#5202).',
    ]);
  });

  it('fills a BOOLEAN-typed required slot the target left optional-and-$', () => {
    // IfcAdvancedFace: IFC4 requires SameSense (index 2, BOOLEAN) — see the
    // generated table. Bounds/FaceSurface are entity references (no honest
    // default) and stay $; SameSense gets IFC4's own "claims nothing" value.
    const line = "#20=IFCADVANCEDFACE($,$,$);";
    const slots = new Ifc4SlotFill();
    const result = convertStepLine(line, 'IFC4X3', 'IFC4', undefined, undefined, undefined, slots);
    expect(result).toBe('#20=IFCADVANCEDFACE($,$,.F.);');
    expect(slots.warnings()[0]).toContain('2 slot(s)');
  });

  it('does not touch a record that already carries a valid value in every required slot', () => {
    const line = "#30=IFCPROJECTEDCRS('EPSG:27700','A description',$,$,$,$,$);";
    const slots = new Ifc4SlotFill();
    const result = convertStepLine(line, 'IFC4X3', 'IFC4', undefined, undefined, undefined, slots);
    expect(result).toBe(line);
    expect(slots.warnings()).toEqual([]);
  });

  it('does not overwrite an already-populated BOOLEAN required slot', () => {
    const line = "#25=IFCADVANCEDFACE($,$,.T.);";
    const slots = new Ifc4SlotFill();
    const result = convertStepLine(line, 'IFC4X3', 'IFC4', undefined, undefined, undefined, slots);
    expect(result).toBe(line);
  });

  it('IFC2X3-target conversions are unaffected: still exactly the pre-#5202 behaviour', () => {
    // No-regression pin: the IFC4 fill must never fire for a downgrade whose
    // target is IFC2X3 — the two mechanisms are independent per `toSchema`.
    const line = "#40=IFCWALL('guid',$,'Wall 1',$,$,$,$,'tag',.STANDARD.);";
    const result = convertStepLine(line, 'IFC4', 'IFC2X3');
    expect(result).not.toContain('.STANDARD.');
    expect(result).toContain('IFCWALL(');
  });

  it('a same-schema conversion is still a no-op', () => {
    const line = "#50=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);";
    expect(convertStepLine(line, 'IFC4', 'IFC4')).toBe(line);
  });
});
