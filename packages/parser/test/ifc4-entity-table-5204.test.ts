/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ENTITY_INFO_BY_UPPER` (`ifc-schema.ts`) folds `@ifc-lite/data`'s
 * `ENTITIES_IFC4` into the bundled cross-schema union. That table (issue
 * #5204, vendored from buildingSMART's C# `SchemaInfo` source) misfiles 24
 * draft-alignment-extension entities into its IFC4 section that exist under
 * no name in the real IFC4 EXPRESS schema — and four of those
 * (`IfcAlignment2DHorizontal`, `IfcAlignmentCurve`, `IfcCurveSegment2D`,
 * `IfcDistanceExpression`, checked directly against `entities-ifc4x3.ts`)
 * exist under no name in the finalized IFC4X3 schema either, so nothing else
 * in the union overrides the bad IFC4 entry. Confirmed by execution before
 * the fix: `isKnownType('IfcAlignment2DHorizontal')` read `true`, with
 * `getAttributeNamesAcrossSchemas` handing back a fabricated attribute list
 * for a name no bundled schema declares.
 */

import { describe, it, expect } from 'vitest';
import { ENTITIES_IFC4, ENTITIES_IFC4_EXPRESS } from '@ifc-lite/data';
import { getSchemaRegistryForVersion } from '../src/generated/schema-registry-by-version.js';
import {
  getAttributeNamesAcrossSchemas,
  getAttributeNamesForSchema,
  isKnownType,
  isInstantiable,
} from '../src/ifc-schema.js';

const PHANTOM_ENTITIES = [
  'IfcAlignment2DHorizontal',
  'IfcAlignmentCurve',
  'IfcCurveSegment2D',
  'IfcDistanceExpression',
];

describe('ifc-schema.ts union does not admit phantom draft-alignment entities (#5204)', () => {
  it('rejects phantom entities as known in any schema', () => {
    for (const phantom of PHANTOM_ENTITIES) {
      expect(isKnownType(phantom), phantom).toBe(false);
      expect(isInstantiable(phantom), phantom).toBe(false);
      expect(getAttributeNamesAcrossSchemas(phantom), phantom).toEqual([]);
      expect(getAttributeNamesForSchema(phantom, 'IFC4'), phantom).toEqual([]);
    }
  });

  it('keeps genuine IFC4X3 entities known, even ones ENTITIES_IFC4 also misfiled', () => {
    // These ARE real IFC4X3 entities under this exact name — the bug is only
    // that `ENTITIES_IFC4` also (wrongly) carries them for IFC4. Rejecting
    // them entirely would be an over-correction: `isKnownType` and the
    // cross-schema accessors are deliberately schema-agnostic (per
    // `getAttributeNamesAcrossSchemas`'s own doc), unlike `schema-tables.ts`'s
    // `entityInfoInSchema`, which IS schema-specific and does reject them for
    // an explicit 'IFC4' query — asserted in `packages/mcp`.
    for (const real4x3 of ['IfcLinearPlacement', 'IfcOffsetCurve', 'IfcTriangulatedIrregularNetwork']) {
      expect(isKnownType(real4x3), real4x3).toBe(true);
      expect(getAttributeNamesAcrossSchemas(real4x3).length, real4x3).toBeGreaterThan(0);
    }
  });

  it('does not report TagList for IfcCartesianPointList3D in IFC4', () => {
    expect(getAttributeNamesForSchema('IfcCartesianPointList3D', 'IFC4')).toEqual(['CoordList']);
    expect(getAttributeNamesAcrossSchemas('IfcCartesianPointList3D')).toEqual(['CoordList']);
  });

  it('leaves an ordinary IFC4 entity correct, attributes in order (no regression)', () => {
    expect(getAttributeNamesAcrossSchemas('IfcWall')).toEqual([
      'GlobalId', 'OwnerHistory', 'Name', 'Description', 'ObjectType',
      'ObjectPlacement', 'Representation', 'Tag', 'PredefinedType',
    ]);
  });
});

/**
 * `ENTITIES_IFC4_EXPRESS` (`@ifc-lite/data`) is the one table every
 * schema-specific IFC4 reader now uses (an oxlint `no-restricted-imports` rule
 * keeps new production code off the raw `ENTITIES_IFC4`). Its corrections are
 * generated in `@ifc-lite/data`, which cannot import this package, so the
 * contract is checked HERE against the live EXPRESS registry: a stale or wrong
 * correction file fails these assertions, not only the generator's `--check`.
 */
describe('ENTITIES_IFC4_EXPRESS (#5204)', () => {
  const registry = getSchemaRegistryForVersion('IFC4').entities;

  it('carries no row with attributes that IFC4 EXPRESS does not declare', () => {
    const undeclared = ENTITIES_IFC4_EXPRESS.filter((e) => e.attributes.length > 0 && !Object.hasOwn(registry, e.name));
    expect(undeclared.map((e) => e.name)).toEqual([]);
    for (const phantom of ['IfcLinearPlacement', 'IfcAlignment2DHorizontal', 'IfcOffsetCurve']) {
      expect(ENTITIES_IFC4_EXPRESS.some((e) => e.name === phantom), phantom).toBe(false);
    }
  });

  it('takes every declared row\'s attribute list from the registry', () => {
    for (const entity of ENTITIES_IFC4_EXPRESS) {
      const meta = registry[entity.name];
      if (!meta) continue;
      expect(entity.attributes, entity.name).toEqual((meta.allAttributes ?? meta.attributes).map((a) => a.name));
    }
    expect(ENTITIES_IFC4_EXPRESS.find((e) => e.name === 'IfcCartesianPointList3D')?.attributes).toEqual(['CoordList']);
  });

  it('takes every declared row\'s parent from the registry, so no row hangs off a dropped one', () => {
    const names = new Set(ENTITIES_IFC4_EXPRESS.map((e) => e.name));
    for (const entity of ENTITIES_IFC4_EXPRESS) {
      const meta = registry[entity.name];
      if (!meta) continue;
      expect(entity.parent, entity.name).toBe(meta.parent ?? undefined);
      if (entity.parent !== undefined) expect(names.has(entity.parent), `${entity.name} -> ${entity.parent}`).toBe(true);
    }
    // The C# table parents these under the IFC4X3-only IfcOffsetCurve.
    expect(ENTITIES_IFC4_EXPRESS.find((e) => e.name === 'IfcOffsetCurve2D')?.parent).toBe('IfcCurve');
  });

  it('keeps the attribute-less defined-type rows the raw table lists', () => {
    const rawEmpty = ENTITIES_IFC4.filter((e) => e.attributes.length === 0).map((e) => e.name);
    const kept = new Set(ENTITIES_IFC4_EXPRESS.map((e) => e.name));
    expect(rawEmpty.length).toBeGreaterThan(100);
    expect(rawEmpty.filter((n) => !kept.has(n))).toEqual([]);
  });
});
