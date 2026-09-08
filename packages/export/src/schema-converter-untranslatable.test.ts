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
});
