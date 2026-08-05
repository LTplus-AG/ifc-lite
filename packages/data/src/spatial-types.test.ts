/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `spatial-types.ts` had no test file. It is the single source of truth for
 * "is this entity part of the spatial tree, and at which level" — consumed
 * by `parser/spatial-hierarchy-builder.ts`, the viewer's hierarchy tree,
 * `basketVisibleSet`, `visibility-adapter` and `PropertiesPanel`.
 *
 * A membership mistake here is silent in the worst way: an entity dropped
 * from `SPATIAL_STRUCTURE_TYPE_ENUMS` simply stops appearing in the model
 * tree, and a `*Name` predicate wired to the wrong set answers plausibly
 * for the majority of inputs.
 */

import { describe, expect, it } from 'vitest';
import {
  BUILDING_LIKE_SPATIAL_TYPE_ENUMS,
  SPACE_LIKE_SPATIAL_TYPE_ENUMS,
  SPATIAL_STRUCTURE_TYPE_ENUMS,
  STOREY_LIKE_SPATIAL_TYPE_ENUMS,
  isBuildingLikeSpatialType,
  isSpaceLikeSpatialType,
  isSpaceLikeSpatialTypeName,
  isSpatialStructureType,
  isSpatialStructureTypeName,
  isStoreyLikeSpatialType,
  isStoreyLikeSpatialTypeName,
} from './spatial-types.js';
import { IfcTypeEnum } from './types.js';

describe('SPATIAL_STRUCTURE_TYPE_ENUMS membership', () => {
  it('contains every level of the IFC spatial tree', () => {
    for (const t of [
      IfcTypeEnum.IfcProject,
      IfcTypeEnum.IfcSite,
      IfcTypeEnum.IfcBuilding,
      IfcTypeEnum.IfcBuildingStorey,
      IfcTypeEnum.IfcSpace,
      IfcTypeEnum.IfcSpatialZone,
    ]) {
      expect(isSpatialStructureType(t)).toBe(true);
    }
  });

  it('contains the IFC4X3 infrastructure facilities and their parts', () => {
    for (const t of [
      IfcTypeEnum.IfcFacility,
      IfcTypeEnum.IfcFacilityPart,
      IfcTypeEnum.IfcBridge,
      IfcTypeEnum.IfcBridgePart,
      IfcTypeEnum.IfcRoad,
      IfcTypeEnum.IfcRoadPart,
      IfcTypeEnum.IfcRailway,
      IfcTypeEnum.IfcRailwayPart,
      IfcTypeEnum.IfcMarineFacility,
    ]) {
      expect(isSpatialStructureType(t)).toBe(true);
    }
  });

  it('excludes ordinary products', () => {
    for (const t of [
      IfcTypeEnum.IfcWall,
      IfcTypeEnum.IfcSlab,
      IfcTypeEnum.IfcDoor,
      IfcTypeEnum.Unknown,
    ]) {
      expect(isSpatialStructureType(t)).toBe(false);
    }
  });

  it('is the union of the three level sets, plus project/site/parts', () => {
    // Every building-like, storey-like and space-like type must also be a
    // spatial-structure type — the sub-sets cannot drift out of the parent.
    for (const t of [
      ...BUILDING_LIKE_SPATIAL_TYPE_ENUMS,
      ...STOREY_LIKE_SPATIAL_TYPE_ENUMS,
      ...SPACE_LIKE_SPATIAL_TYPE_ENUMS,
    ]) {
      expect(SPATIAL_STRUCTURE_TYPE_ENUMS).toContain(t);
    }
  });
});

describe('level predicates are mutually exclusive', () => {
  // Each of the three levels must answer for its own types and reject the
  // other two; a predicate wired to a neighbouring set passes any test that
  // only checks positives.
  const cases: Array<[IfcTypeEnum, 'building' | 'storey' | 'space']> = [
    [IfcTypeEnum.IfcBuilding, 'building'],
    [IfcTypeEnum.IfcFacility, 'building'],
    [IfcTypeEnum.IfcBridge, 'building'],
    [IfcTypeEnum.IfcBuildingStorey, 'storey'],
    [IfcTypeEnum.IfcSpace, 'space'],
    [IfcTypeEnum.IfcSpatialZone, 'space'],
  ];

  for (const [type, level] of cases) {
    it(`${IfcTypeEnum[type] ?? type} is ${level}-like and nothing else`, () => {
      expect(isBuildingLikeSpatialType(type)).toBe(level === 'building');
      expect(isStoreyLikeSpatialType(type)).toBe(level === 'storey');
      expect(isSpaceLikeSpatialType(type)).toBe(level === 'space');
    });
  }

  it('rejects a non-spatial type at every level', () => {
    expect(isBuildingLikeSpatialType(IfcTypeEnum.IfcWall)).toBe(false);
    expect(isStoreyLikeSpatialType(IfcTypeEnum.IfcWall)).toBe(false);
    expect(isSpaceLikeSpatialType(IfcTypeEnum.IfcWall)).toBe(false);
  });
});

describe('name-based predicates', () => {
  it('agree with their enum counterparts on PascalCase IFC names', () => {
    expect(isStoreyLikeSpatialTypeName('IfcBuildingStorey')).toBe(true);
    expect(isSpaceLikeSpatialTypeName('IfcSpace')).toBe(true);
    expect(isSpaceLikeSpatialTypeName('IfcSpatialZone')).toBe(true);
    expect(isSpatialStructureTypeName('IfcBuilding')).toBe(true);
  });

  // Cross-level negatives: these are what separate `isSpaceLikeSpatialTypeName`
  // from a delegation to the storey-like set (and vice versa).
  it('do not answer for a neighbouring level', () => {
    expect(isSpaceLikeSpatialTypeName('IfcBuildingStorey')).toBe(false);
    expect(isStoreyLikeSpatialTypeName('IfcSpace')).toBe(false);
    expect(isStoreyLikeSpatialTypeName('IfcSpatialZone')).toBe(false);
    expect(isSpaceLikeSpatialTypeName('IfcBuilding')).toBe(false);
  });

  it('reject non-spatial and unknown names', () => {
    expect(isSpatialStructureTypeName('IfcWall')).toBe(false);
    expect(isStoreyLikeSpatialTypeName('NotAnIfcType')).toBe(false);
    expect(isSpaceLikeSpatialTypeName('NotAnIfcType')).toBe(false);
  });

  it('reject null, undefined and the empty string', () => {
    for (const bad of [null, undefined, '']) {
      expect(isSpatialStructureTypeName(bad)).toBe(false);
      expect(isStoreyLikeSpatialTypeName(bad)).toBe(false);
      expect(isSpaceLikeSpatialTypeName(bad)).toBe(false);
    }
  });

  it('are case-sensitive on the PascalCase spelling', () => {
    // The name set is built from IfcTypeEnumToString, which emits PascalCase.
    expect(isSpatialStructureTypeName('IFCBUILDINGSTOREY')).toBe(false);
  });
});
