/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-schema merge legality: an IFC4-only entity type that has NO
 * representation in an older target schema — not a rename, not an
 * attribute-count difference, genuinely absent from the target schema's
 * generated entity table — must never survive `convertStepLine` unchanged.
 * Before this fix it did: `shouldSkipEntity` only hand-listed 4 alignment
 * types, so every other unmapped type (tessellated-geometry representation
 * items, point lists, curves, georeferencing, IFC4 material composition)
 * passed through verbatim, producing a file whose header declares IFC2X3 but
 * whose body contains entity types IFC2X3 never defined — silent cross-schema
 * illegality, invisible to any test that doesn't reparse the output under the
 * declared schema.
 *
 * Non-rooted (no GlobalId) unmapped types have no safe substitute: they are
 * referenced POSITIONALLY (an `IfcShapeRepresentation.Items` entry, an
 * `IfcGeometricRepresentationContext` attribute), so an IFCPROXY placeholder
 * (an IfcProduct) would swap one illegal file for a differently-illegal one,
 * and dropping the line would dangle the referencing entity's `#N`. The
 * honest behaviour `MergeExportOptions.schema`'s doc comment promises
 * ("any version, will convert if needed") is to refuse with a clear error
 * rather than guess — see `resolveUnrepresentedEntity` in
 * `schema-untranslatable.ts`.
 */
import { describe, it, expect } from 'vitest';
import { convertStepLine } from './schema-converter.js';

describe('convertStepLine refuses an unrepresentable non-rooted entity rather than passing it through', () => {
  it('IFCTRIANGULATEDFACESET (IFC4 tessellated geometry, no IFC2X3 equivalent) throws', () => {
    const line = "#100=IFCTRIANGULATEDFACESET(#50,$,.F.,((1,2,3),(1,3,4)),$);";
    expect(() => convertStepLine(line, 'IFC4', 'IFC2X3')).toThrow(/IFCTRIANGULATEDFACESET/);
  });

  it('IFCCARTESIANPOINTLIST3D (IFC4 tessellation point list, no IFC2X3 equivalent) throws', () => {
    const line = "#101=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));";
    expect(() => convertStepLine(line, 'IFC4', 'IFC2X3')).toThrow(/IFCCARTESIANPOINTLIST3D/);
  });

  it('IFCINDEXEDPOLYCURVE (IFC4 curve using a point list, no IFC2X3 equivalent) throws', () => {
    const line = "#102=IFCINDEXEDPOLYCURVE(#101,$,$);";
    expect(() => convertStepLine(line, 'IFC4', 'IFC2X3')).toThrow(/IFCINDEXEDPOLYCURVE/);
  });

  it('IFCMAPCONVERSION (IFC4 georeferencing, no IFC2X3 equivalent) throws', () => {
    const line = "#18=IFCMAPCONVERSION(#3,#19,10.,20.,0.,$,$,$);";
    expect(() => convertStepLine(line, 'IFC4', 'IFC2X3')).toThrow(/IFCMAPCONVERSION/);
  });

  it('IFCMATERIALCONSTITUENTSET (IFC4 material composition, no IFC2X3 equivalent) throws', () => {
    const line = "#20=IFCMATERIALCONSTITUENTSET('Set',$,(#21));";
    expect(() => convertStepLine(line, 'IFC4', 'IFC2X3')).toThrow(/IFCMATERIALCONSTITUENTSET/);
  });

  it('rooted unmapped types (e.g. the existing hand-listed alignment entities) still get an IFCPROXY placeholder, not an error', () => {
    const line = "#200=IFCALIGNMENTHORIZONTAL('1J8x2ZfE10ThvyLD8Y5NjM',$,$,$,$,$);";
    const out = convertStepLine(line, 'IFC4X3', 'IFC2X3');
    expect(out).toContain('IFCPROXY');
  });

  it('same-schema conversion is a no-op (control: throwing is scoped to a genuine cross-schema gap)', () => {
    const line = "#100=IFCTRIANGULATEDFACESET(#50,$,.F.,((1,2,3),(1,3,4)),$);";
    expect(convertStepLine(line, 'IFC4', 'IFC4')).toBe(line);
  });

  // #4206: IfcStructuralLoadConfiguration is the ONE non-rooted type this
  // package can omit instead of throw for -- but only from a caller that
  // proves every referrer is redirected too, by supplying `withheldRefIds`.
  describe('IFCSTRUCTURALLOADCONFIGURATION (#4206 withholding, scoped to callers that opt in)', () => {
    const line = "#326=IFCSTRUCTURALLOADCONFIGURATION($,(#327,#329),((96.)));";

    it('still throws with no withheldRefIds argument (control: the 5-argument form did not change)', () => {
      expect(() => convertStepLine(line, 'IFC4', 'IFC2X3')).toThrow(/IFCSTRUCTURALLOADCONFIGURATION/);
    });

    it('is omitted (returns null, not a thrown error) once a caller supplies withheldRefIds, even an empty set', () => {
      // Size does not gate this record's OWN fate -- an empty set still
      // proves the CALLER's pipeline redirects referrers when asked to (real
      // callers always pass a defined set, computed once per export, empty
      // whenever nothing needs withholding). What decides whether THIS
      // record is omitted is its own type having no IFC2X3 representation.
      expect(convertStepLine(line, 'IFC4', 'IFC2X3', undefined, undefined, new Set())).toBeNull();
    });

    it('is also omitted with a non-empty, unrelated withheldRefIds set', () => {
      // The set only needs to be non-empty to prove the caller opted in --
      // this record's own id (#326) need not be a member of it; what makes
      // THIS line itself get omitted is its OWN type having no IFC2X3
      // representation, independent of what other ids are withheld.
      const withheld = new Set([999]);
      expect(convertStepLine(line, 'IFC4', 'IFC2X3', undefined, undefined, withheld)).toBeNull();
    });

    it('a referrer whose AppliedLoad names a withheld id is redirected to a proxy, not left dangling', () => {
      const action = "#317=IFCSTRUCTURALCURVEACTION('guid',$,$,$,$,$,$,#326,.GLOBAL_COORDS.,.F.,$,.LINEAR.);";
      const withheld = new Set([326]);
      const out = convertStepLine(action, 'IFC4', 'IFC2X3', undefined, undefined, withheld);
      expect(out).toContain('IFCPROXY');
      expect(out).not.toContain('#326');
      expect(out).not.toContain('IFCSTRUCTURALLINEARACTION');
    });

    it('a referrer is NOT redirected when the id it names is not in withheldRefIds (control: the check is precise, not "any structural action becomes a proxy")', () => {
      const action = "#317=IFCSTRUCTURALCURVEACTION('guid',$,$,$,$,$,$,#900,.GLOBAL_COORDS.,.F.,$,.LINEAR.);";
      const withheld = new Set([326]); // #900 is not withheld
      const out = convertStepLine(action, 'IFC4', 'IFC2X3', undefined, undefined, withheld);
      expect(out).toContain('IFCSTRUCTURALLINEARACTION');
      expect(out).toContain('#900');
      expect(out).not.toContain('IFCPROXY');
    });
  });
});
