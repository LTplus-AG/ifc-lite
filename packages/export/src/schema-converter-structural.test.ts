/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite convert <file> --schema IFC2X3` on an IFC4 structural-analysis
 * model silently destroyed every `IfcStructuralLoadCase`,
 * `IfcStructuralCurveAction` and `IfcStructuralSurfaceAction`: none of the
 * three had an `IFC4_TO_IFC2X3` entry, so `convertStepLine` treated them as
 * having NO IFC2X3 representation and replaced each with an IFCPROXY
 * carrying a freshly minted GlobalId — losing the load classification and
 * the applied-load reference — even though IFC2X3 has a real target for
 * each (`IfcStructuralLoadGroup`, `IfcStructuralLinearAction`,
 * `IfcStructuralPlanarAction`). Same bug class as #4206's door/window fix
 * (`schema-converter-door-window-type.test.ts`), never applied to the
 * structural domain until now.
 *
 * Input lines are taken verbatim (attribute values) from the real
 * Constructivity export `tests/models/ifcopenshell/structural_analysis_curve.ifc`
 * (express ids #312, #317), so this pins the fix against the project's own
 * canonical structural fixture, not a hand-built line.
 */
import { describe, it, expect } from 'vitest';
import { convertStepLine } from './schema-converter.js';

describe('convertStepLine maps structural analysis IFC4 types to their IFC2X3 targets (#4206)', () => {
  it('IFCSTRUCTURALLOADCASE trims to IFCSTRUCTURALLOADGROUP (strict attribute-name prefix, no by-name remap needed)', () => {
    const line =
      "#312=IFCSTRUCTURALLOADCASE('2fv4DZfY55exwX8QDy8dmw',#209,'Structural Load Case #1',$,$," +
      '.LOAD_CASE.,.NOTDEFINED.,.NOTDEFINED.,1.,$,(0.,0.,0.));';
    const out = convertStepLine(line, 'IFC4', 'IFC2X3');

    expect(out).not.toContain('IFCPROXY');
    expect(out).toContain('IFCSTRUCTURALLOADGROUP');
    expect(out).toContain("'2fv4DZfY55exwX8QDy8dmw'");
    expect(out).toContain('.LOAD_CASE.');
    // SelfWeightCoefficients has no IFC2X3 slot on IfcStructuralLoadGroup and is dropped.
    expect(out).not.toContain('(0.,0.,0.)');
    expect(out).toBe(
      "#312=IFCSTRUCTURALLOADGROUP('2fv4DZfY55exwX8QDy8dmw',#209,'Structural Load Case #1',$,$," +
        '.LOAD_CASE.,.NOTDEFINED.,.NOTDEFINED.,1.,$);',
    );
  });

  it('IFCSTRUCTURALCURVEACTION maps to IFCSTRUCTURALLINEARACTION and keeps its GlobalId and AppliedLoad reference', () => {
    const line =
      "#317=IFCSTRUCTURALCURVEACTION('2WSwGyLsrFNA9TLOq_ifyd',#209,'Structural Curve Action #1',$,$,$,$," +
      '#326,.GLOBAL_COORDS.,.F.,$,.LINEAR.);';
    const out = convertStepLine(line, 'IFC4', 'IFC2X3');

    expect(out).not.toContain('IFCPROXY');
    expect(out).toContain('IFCSTRUCTURALLINEARACTION');
    expect(out).toContain("'2WSwGyLsrFNA9TLOq_ifyd'");
    // AppliedLoad (#326) and GlobalOrLocal/DestabilizingLoad survive by name.
    expect(out).toContain('#326');
    expect(out).toContain('.GLOBAL_COORDS.');
    // PredefinedType (IFC4-only, .LINEAR.) has no IFC2X3 slot and is dropped;
    // CausedBy (IFC2X3-only, optional) has no IFC4 source and stays `$`.
    expect(out).not.toContain('.LINEAR.');
    expect(out).toBe(
      "#317=IFCSTRUCTURALLINEARACTION('2WSwGyLsrFNA9TLOq_ifyd',#209,'Structural Curve Action #1',$,$,$,$," +
        '#326,.GLOBAL_COORDS.,.F.,$,$);',
    );
  });

  it('IFCSTRUCTURALSURFACEACTION maps to IFCSTRUCTURALPLANARACTION with the same by-name reconciliation', () => {
    const line =
      "#1=IFCSTRUCTURALSURFACEACTION('0SURFACEACTION0000001',$,'Surface Action',$,$,$,$," +
      '#2,.GLOBAL_COORDS.,.T.,.T.,.BILINEAR.);';
    const out = convertStepLine(line, 'IFC4', 'IFC2X3');

    expect(out).not.toContain('IFCPROXY');
    // ProjectedOrTrue (.T.) survives by name; PredefinedType (.BILINEAR.) has
    // no IFC2X3 slot and is dropped; CausedBy has no IFC4 source and stays `$`.
    expect(out).toBe(
      "#1=IFCSTRUCTURALPLANARACTION('0SURFACEACTION0000001',$,'Surface Action',$,$,$,$," +
        '#2,.GLOBAL_COORDS.,.T.,$,.T.);',
    );
  });

  it('IFCSTRUCTURALCURVEREACTION still has no IFC2X3 representation and becomes an IFCPROXY (control: not part of this fix — IFC2X3 genuinely has no curve/surface reaction type)', () => {
    const line =
      "#2773=IFCSTRUCTURALCURVEREACTION('0SH7YcIWrB8Q4VcWjfXpnn',#209,$,$,$,$,$,#2772,.GLOBAL_COORDS.,.DISCRETE.);";
    const out = convertStepLine(line, 'IFC4', 'IFC2X3');
    expect(out).toContain('IFCPROXY');
    // A proxy placeholder mints its own deterministic GlobalId rather than
    // reusing the source one (federated-merge identity, #2733) — the
    // reaction's original GlobalId, AppliedLoad and DISCRETE classification
    // are genuinely gone, which is exactly what the loss report must name.
    expect(out).not.toContain('#2772');
  });

  it('round-trips IFC2X3 → IFC4 without renaming IfcStructuralLoadGroup (control: a plain LOAD_GROUP predefined type is not a load case)', () => {
    const line =
      "#1=IFCSTRUCTURALLOADGROUP('guid',$,'Group',$,$,.LOAD_GROUP.,.NOTDEFINED.,.NOTDEFINED.,1.,$);";
    // IfcStructuralLoadGroup is valid in both schemas under its own name — IFC4
    // only added a NEW subtype (IfcStructuralLoadCase); it did not remove or
    // rename IfcStructuralLoadGroup itself, so the upgrade leg pads $, not renames.
    const upgraded = convertStepLine(line, 'IFC2X3', 'IFC4');
    expect(upgraded).toBe(
      "#1=IFCSTRUCTURALLOADGROUP('guid',$,'Group',$,$,.LOAD_GROUP.,.NOTDEFINED.,.NOTDEFINED.,1.,$);",
    );
  });
});
