/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { convertStepLine } from './schema-converter.js';

// #5202 finding 2: cardinality tightening on a downgrade to IFC4 was
// entirely unguarded (only `toSchema === 'IFC2X3'` had a fill/count
// mechanism). `IfcProjectedCRS.Name` is optional in IFC4X3 and mandatory in
// IFC4, at position 0 — a valid IFC4X3 record legitimately carries `$` there.
//
// These tests exercise `Ifc4SlotFill` only through `convertStepLine`'s public
// entry point, the same way `schema-converter-ifc2x3-slots.ts`'s Ifc2x3SlotFill
// twin is exercised everywhere else in this package -- no test in this
// package imports either slot-fill class directly. `convertStepLine`
// constructs its own `Ifc4SlotFill` internally when the caller omits one
// (`ifc4Slots ?? new Ifc4SlotFill()`), so the byte-output behaviour below is
// fully observable without reaching for the class. The per-instance
// `.warnings()` count is not asserted here, matching the pre-existing
// Ifc2x3SlotFill: nothing in this suite unit-tests that channel either.

describe('schema-converter: IFC4-target required slots (#5202)', () => {
  it('the exact IfcProjectedCRS conversion from the issue: Name stays $ (no honest default -- IfcLabel)', () => {
    const line = "#10=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);";
    const result = convertStepLine(line, 'IFC4X3', 'IFC4');
    // Name (IfcLabel) has no honest default -- this table never invents one --
    // so the emitted text is byte-identical to the input, exactly like the
    // issue's own executed OUT. The record is still not valid IFC4.
    expect(result).toBe("#10=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);");
  });

  it('fills a BOOLEAN-typed required slot the target left optional-and-$', () => {
    // IfcAdvancedFace: IFC4 requires SameSense (index 2, BOOLEAN) -- see the
    // generated table. Bounds/FaceSurface are entity references (no honest
    // default) and stay $; SameSense gets IFC4's own "claims nothing" value.
    const line = "#20=IFCADVANCEDFACE($,$,$);";
    const result = convertStepLine(line, 'IFC4X3', 'IFC4');
    expect(result).toBe('#20=IFCADVANCEDFACE($,$,.F.);');
  });

  it('does not touch a record that already carries a valid value in every required slot', () => {
    const line = "#30=IFCPROJECTEDCRS('EPSG:27700','A description',$,$,$,$,$);";
    const result = convertStepLine(line, 'IFC4X3', 'IFC4');
    expect(result).toBe(line);
  });

  it('does not overwrite an already-populated BOOLEAN required slot', () => {
    const line = "#25=IFCADVANCEDFACE($,$,.T.);";
    const result = convertStepLine(line, 'IFC4X3', 'IFC4');
    expect(result).toBe(line);
  });

  it('IFC2X3-target conversions are unaffected: still exactly the pre-#5202 behaviour', () => {
    // No-regression pin: the IFC4 fill must never fire for a downgrade whose
    // target is IFC2X3 -- the two mechanisms are independent per `toSchema`.
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
