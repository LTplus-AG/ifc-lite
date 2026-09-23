/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #5204: `attrNameTable('IFC4')` used to read `@ifc-lite/data`'s
 * `ENTITIES_IFC4` — generated from buildingSMART's vendored C# `SchemaInfo`
 * source, which misfiles several IFC4X3-only entities (the alignment
 * domain: `IfcLinearPlacement`, `IfcOffsetCurve`,
 * `IfcTriangulatedIrregularNetwork`, …) into its IFC4 section, and gives
 * `IfcCartesianPointList2D`/`3D` an IFC4X3-only `TagList` attribute under
 * IFC4. That table is wrong in the vendored upstream source itself, not
 * something this repo's generator introduced (`packages/data/scripts/
 * upstream/SchemaInfo.Schemas.g.cs`'s own `GetClassesIFC4()` method already
 * declares `IfcOffsetCurve`'s `TagList`-bearing `IfcCartesianPointList3D`,
 * verified by reading the vendored file directly) — so patching it once
 * would leave the next `pnpm run generate:ifc-schema` free to reintroduce
 * it, and regenerating from EXPRESS is not an option here because there is
 * no in-repo EXPRESS parser for this table, only a C#-source parser.
 *
 * `packages/parser/src/generated/schema-registry*.ts`, generated from the
 * EXPRESS schema text itself (`packages/codegen/schemas/*.exp`), does not
 * have this bug. `attrNameTable` now builds its per-schema attribute-name
 * table from those registries instead (`schema-converter.ts`), so an entity
 * absent from `toSchema`'s EXPRESS schema reads as absent (`tgtAttrs` stays
 * `undefined`), which routes it through the EXISTING `resolveUnrepresentedEntity`
 * dispatch `schema-converter.ts` already had for any unmapped type: an
 * IfcRoot subtype becomes `IFCPROXY`, everything else refuses (throws) rather
 * than being dropped or left dangling.
 *
 * Before this fix, all three assertions below failed: the three pass-through
 * entities emitted their SOURCE type name and attributes verbatim into a
 * `FILE_SCHEMA(('IFC4'))` line, and `IfcCartesianPointList3D` kept its
 * IFC4X3-only `TagList` attribute under IFC4.
 */
import { describe, it, expect } from 'vitest';
import { convertStepLine } from './schema-converter.js';

describe('IFC4X3-only entities absent from the wrong entity table no longer pass through unconverted (#5204)', () => {
  // Three of the 20 entities the issue names as passing straight through:
  // present (wrongly) in `ENTITIES_IFC4`, absent from real IFC4 EXPRESS, and
  // not covered by `shouldSkipEntity`'s hand-listed alignment set or the
  // `IFC4X3_TO_IFC4` rename map.
  it('IFCLINEARPLACEMENT (IfcObjectPlacement subtype, non-rooted) refuses rather than passing through', () => {
    const line = "#300=IFCLINEARPLACEMENT(#1,#2,$,$);";
    expect(() => convertStepLine(line, 'IFC4X3', 'IFC4')).toThrow(/IFCLINEARPLACEMENT/);
  });

  it('IFCOFFSETCURVE (IfcCurve subtype, non-rooted) refuses rather than passing through', () => {
    const line = "#301=IFCOFFSETCURVE(#5);";
    expect(() => convertStepLine(line, 'IFC4X3', 'IFC4')).toThrow(/IFCOFFSETCURVE/);
  });

  it('IFCTRIANGULATEDIRREGULARNETWORK (IfcTriangulatedFaceSet subtype, non-rooted) refuses rather than passing through', () => {
    const line = "#302=IFCTRIANGULATEDIRREGULARNETWORK(#6,$,.F.,((1,2,3)),$,$,$);";
    expect(() => convertStepLine(line, 'IFC4X3', 'IFC4')).toThrow(/IFCTRIANGULATEDIRREGULARNETWORK/);
  });

  it('none of the three silently keeps its source type name in a line converted to IFC4 (the actual defect)', () => {
    // The bug never threw and never proxied -- it returned the line with the
    // UNCONVERTED type name intact under a header declaring IFC4. Assert the
    // absence of that shape directly, not just "it throws", so a future
    // regression that swaps the throw for a silent pass-through is caught
    // even if the throw assertions above are ever loosened.
    for (const line of [
      "#300=IFCLINEARPLACEMENT(#1,#2,$,$);",
      "#301=IFCOFFSETCURVE(#5);",
      "#302=IFCTRIANGULATEDIRREGULARNETWORK(#6,$,.F.,((1,2,3)),$,$,$);",
    ]) {
      let out: string | null = null;
      let threw = false;
      try {
        out = convertStepLine(line, 'IFC4X3', 'IFC4');
      } catch {
        threw = true;
      }
      expect(threw || out === null || !out.startsWith(line.slice(0, line.indexOf('(') + 1))).toBe(true);
    }
  });
});

describe('IfcCartesianPointList2D/3D TagList case (#5204)', () => {
  it('IFCCARTESIANPOINTLIST3D drops the IFC4X3-only TagList converting IFC4X3 → IFC4', () => {
    const line = "#100=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,1.,1.)),('tag1','tag2'));";
    const result = convertStepLine(line, 'IFC4X3', 'IFC4');
    expect(result).toBe("#100=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,1.,1.)));");
  });

  it('IFCCARTESIANPOINTLIST2D drops the IFC4X3-only TagList converting IFC4X3 → IFC4', () => {
    const line = "#101=IFCCARTESIANPOINTLIST2D(((0.,0.),(1.,1.)),('tag1','tag2'));";
    const result = convertStepLine(line, 'IFC4X3', 'IFC4');
    expect(result).toBe("#101=IFCCARTESIANPOINTLIST2D(((0.,0.),(1.,1.)));");
  });

  it('IFCCARTESIANPOINTLIST3D pads a second slot converting IFC4 → IFC4X3 (arity genuinely differs)', () => {
    const line = "#102=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,1.,1.)));";
    const result = convertStepLine(line, 'IFC4', 'IFC4X3');
    expect(result).toBe("#102=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,1.,1.)),$);");
  });

  it('a 1-argument IFC4 record no longer emits unchanged (under-padded arity) into an IFC4X3 file', () => {
    const line = "#103=IFCCARTESIANPOINTLIST3D(((0.,0.,0.)));";
    const result = convertStepLine(line, 'IFC4', 'IFC4X3');
    expect(result).not.toBe(line);
    expect(result).toBe("#103=IFCCARTESIANPOINTLIST3D(((0.,0.,0.)),$);");
  });
});

describe('no-regression pins', () => {
  it('the four rename-map-protected entities still become IFCPROXY converting IFC4X3 → IFC4', () => {
    const cases: Array<[string, string]> = [
      ['IFCALIGNMENT', "#400=IFCALIGNMENT('guid',$,'Align',$,$,$,$,$,$);"],
      ['IFCLINEARPOSITIONINGELEMENT', "#401=IFCLINEARPOSITIONINGELEMENT('guid',$,$,$,$,$,$,$);"],
      ['IFCPOSITIONINGELEMENT', "#402=IFCPOSITIONINGELEMENT('guid',$,$,$,$,$,$);"],
      ['IFCREFERENT', "#403=IFCREFERENT('guid',$,'Ref',$,$,#13,$,$,.STATION.);"],
    ];
    for (const [type, line] of cases) {
      const result = convertStepLine(line, 'IFC4X3', 'IFC4');
      expect(result, `${type} should become IFCPROXY`).toContain('IFCPROXY(');
      // These four are protected via the IFC4X3_TO_IFC4 rename map (a direct
      // type-name rename to IFCPROXY, not `resolveUnrepresentedEntity`'s
      // synthesized placeholder), so the record's own attributes carry
      // through rather than the original type name landing in a Tag slot.
      expect(result, `${type} should not keep its own type name`).not.toContain(`'${type}'`);
    }
  });

  it('an ordinary IFC4-valid entity converts unchanged (IFC4X3 → IFC4, IFCWALL)', () => {
    const line = "#500=IFCWALL('guid',$,'Wall',$,$,$,$,$,.NOTDEFINED.);";
    expect(convertStepLine(line, 'IFC4X3', 'IFC4')).toBe(line);
  });

  it('IFC4 → IFC2X3 still throws for an entity with no IFC2X3 representation (IFCTRIANGULATEDFACESET)', () => {
    const line = "#600=IFCTRIANGULATEDFACESET(#50,$,.F.,((1,2,3),(1,3,4)),$);";
    expect(() => convertStepLine(line, 'IFC4', 'IFC2X3')).toThrow(/IFCTRIANGULATEDFACESET/);
  });
});
