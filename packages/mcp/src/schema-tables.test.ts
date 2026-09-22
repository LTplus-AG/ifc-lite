/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ENTITIES_IFC4` (`@ifc-lite/data`, vendored from buildingSMART's C#
 * `SchemaInfo` source) is wrong for IFC4 in two ways (issue #5204): it gives
 * `IfcCartesianPointList2D`/`3D` a `TagList` attribute IFC4 has never had,
 * and it misfiles 24 draft-alignment-extension entities —
 * `IfcAlignment2DHorizontal`, `IfcLinearPlacement`, `IfcOffsetCurve`, … —
 * that exist under NO name in the real IFC4 schema, nor (renamed) in the
 * finalized IFC4X3 one. `schema-tables.ts` is the table an MCP client's
 * `schema_describe`/query-backend calls answer from, so a wrong row there is
 * a wrong answer handed straight to an LLM agent.
 */

import { describe, it, expect } from 'vitest';
import { entityInfoInSchema, entityInfoAcrossSchemas, attributeNamesForSchema } from './schema-tables.js';

describe('schema-tables IFC4 row correctness (#5204)', () => {
  it('does not report TagList for IfcCartesianPointList3D in IFC4', () => {
    const info = entityInfoInSchema('IfcCartesianPointList3D', 'IFC4');
    expect(info?.attributes).toEqual(['CoordList']);
    expect(attributeNamesForSchema('IfcCartesianPointList3D', 'IFC4')).toEqual(['CoordList']);
  });

  it('does not report TagList for IfcCartesianPointList2D in IFC4', () => {
    const info = entityInfoInSchema('IfcCartesianPointList2D', 'IFC4');
    expect(info?.attributes).toEqual(['CoordList']);
  });

  it('does not present a phantom draft-alignment-2D entity as valid in ANY bundled schema', () => {
    // These four exist under no name in the real IFC4 EXPRESS schema, nor
    // (checked directly against `entities-ifc4x3.ts`) in the finalized
    // IFC4X3 alignment domain — that domain renamed the survivors instead
    // (`IfcAlignment2DHorizontal` -> `IfcAlignmentHorizontal`). Unlike the
    // entities below, no bundled schema should resolve them at all.
    for (const phantom of [
      'IfcAlignment2DHorizontal',
      'IfcAlignmentCurve',
      'IfcCurveSegment2D',
      'IfcDistanceExpression',
    ]) {
      expect(entityInfoInSchema(phantom, 'IFC4'), phantom).toBeUndefined();
      expect(entityInfoAcrossSchemas(phantom), phantom).toBeUndefined();
    }
  });

  it('rejects a genuine-IFC4X3 entity as an IFC4 row, but keeps resolving it in IFC4X3', () => {
    // Unlike the four phantoms above, these ARE real IFC4X3 entities under
    // this exact name (confirmed against `entities-ifc4x3.ts`) — the bug is
    // only that `ENTITIES_IFC4` also misfiled them into IFC4. Schema-specific
    // IFC4 lookup must reject them; the cross-schema union must still resolve
    // them, correctly attributed to IFC4X3.
    for (const real4x3 of ['IfcLinearPlacement', 'IfcOffsetCurve', 'IfcTriangulatedIrregularNetwork']) {
      expect(entityInfoInSchema(real4x3, 'IFC4'), real4x3).toBeUndefined();
      const resolved = entityInfoAcrossSchemas(real4x3);
      expect(resolved?.schema, real4x3).toBe('IFC4X3');
    }
  });

  it('still reports an ordinary IFC4 entity correctly, attributes in order', () => {
    const info = entityInfoInSchema('IfcWall', 'IFC4');
    expect(info?.attributes).toEqual([
      'GlobalId', 'OwnerHistory', 'Name', 'Description', 'ObjectType',
      'ObjectPlacement', 'Representation', 'Tag', 'PredefinedType',
    ]);
    expect(info?.parent).toBe('IfcBuildingElement');
    expect(info?.abstract).toBe(false);
  });

  it('still resolves a genuinely IFC4X3-only entity across schemas', () => {
    // `IfcAlignment` is a real IFC4X3 entity (unlike the draft-2D-domain
    // phantoms above) and must keep resolving through the union.
    const resolved = entityInfoAcrossSchemas('IfcAlignment');
    expect(resolved?.schema).toBe('IFC4X3');
    expect(resolved?.info.attributes.length).toBeGreaterThan(0);
  });

  it('leaves IFC2X3 and IFC4X3 rows untouched', () => {
    // #5204 implicates only the IFC4 table.
    const ifc2x3 = entityInfoInSchema('IfcWall', 'IFC2X3');
    expect(ifc2x3?.attributes).toEqual([
      'GlobalId', 'OwnerHistory', 'Name', 'Description', 'ObjectType',
      'ObjectPlacement', 'Representation', 'Tag',
    ]);
  });
});
