/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SCHEMA_MAPS.IFC4` (`retype.ts`) used to read `@ifc-lite/data`'s
 * `ENTITIES_IFC4` directly. That table (issue #5204, vendored from
 * buildingSMART's C# `SchemaInfo` source) misfiles 24 draft-alignment
 * entities as IFC4-valid and gives `IfcCartesianPointList2D`/`3D` a
 * `TagList` attribute IFC4 has never had. `retypeArgTokens` re-lays-out an
 * entity's STEP arguments POSITIONALLY against the target class's declared
 * attribute list, so a wrong list there is not a display bug — it writes an
 * extra/wrong argument, or a class keyword no real IFC4 STEP file can
 * contain, straight into an exported `FILE_SCHEMA(('IFC4'))` file.
 */

import { describe, it, expect } from 'vitest';
import { retypeArgTokens, retypeStepLine } from './retype.js';

describe('retype against the IFC4 entity table (#5204)', () => {
  it('does not append a spurious TagList slot when retyping into IfcCartesianPointList3D (IFC4)', () => {
    const result = retypeArgTokens(["((0.,0.,0.),(1.,1.,1.))"], 'IfcCartesianPointList3D', 'IfcCartesianPointList3D', null, 'IFC4');
    expect(result.resolved).toBe(true);
    expect(result.tokens).toEqual(["((0.,0.,0.),(1.,1.,1.))"]);
  });

  it('does not retype into a phantom draft-alignment class in IFC4 (falls back to keyword-only swap, not silently)', () => {
    const result = retypeArgTokens(['1.0', '(1,2)'], 'IfcAlignment2DHorizontal', 'IfcAlignment2DHorizontal', null, 'IFC4');
    // Neither source nor target layout resolves for a class absent from IFC4
    // -- `resolved: false` tells the caller to fall back to a keyword-only
    // swap rather than fabricate a positional layout for a class the target
    // schema does not have.
    expect(result.resolved).toBe(false);
  });

  it('retypeStepLine does not write a TagList `$` slot into an IFC4 IfcCartesianPointList3D record', () => {
    const line = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,1.,1.)));\n";
    const out = retypeStepLine(line, 'IfcCartesianPointList3D', 'IfcCartesianPointList3D', null, 'IFC4');
    expect(out).toBe(line);
  });

  it('still resolves an ordinary IFC4 retype correctly (no regression)', () => {
    // IfcBuildingElementProxy -> IfcColumn: IFC4 layout is attribute-identical
    // for the shared IfcElement prefix, so a plain keyword swap with the same
    // 8 tokens must round-trip unchanged.
    const result = retypeArgTokens(
      ["'g'", '$', "'n'", '$', '$', '$', '$', '$'],
      'IfcBuildingElementProxy',
      'IfcColumn',
      null,
      'IFC4',
    );
    expect(result.resolved).toBe(true);
    expect(result.tokens).toEqual(["'g'", '$', "'n'", '$', '$', '$', '$', '$', '$']);
  });
});
