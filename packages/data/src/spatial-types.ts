/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcTypeEnum, IfcTypeEnumFromString, IfcTypeEnumToString } from './types.js';

export const SPATIAL_STRUCTURE_TYPE_ENUMS = [
  IfcTypeEnum.IfcProject,
  IfcTypeEnum.IfcSite,
  IfcTypeEnum.IfcBuilding,
  IfcTypeEnum.IfcBuildingStorey,
  IfcTypeEnum.IfcSpace,
  IfcTypeEnum.IfcFacility,
  IfcTypeEnum.IfcFacilityPart,
  IfcTypeEnum.IfcBridge,
  IfcTypeEnum.IfcBridgePart,
  IfcTypeEnum.IfcRoad,
  IfcTypeEnum.IfcRoadPart,
  IfcTypeEnum.IfcRailway,
  IfcTypeEnum.IfcRailwayPart,
  IfcTypeEnum.IfcMarineFacility,
] as const;

export const BUILDING_LIKE_SPATIAL_TYPE_ENUMS = [
  IfcTypeEnum.IfcBuilding,
  IfcTypeEnum.IfcFacility,
  IfcTypeEnum.IfcBridge,
  IfcTypeEnum.IfcRoad,
  IfcTypeEnum.IfcRailway,
  IfcTypeEnum.IfcMarineFacility,
] as const;

export const STOREY_LIKE_SPATIAL_TYPE_ENUMS = [
  IfcTypeEnum.IfcBuildingStorey,
] as const;

export const SPACE_LIKE_SPATIAL_TYPE_ENUMS = [
  IfcTypeEnum.IfcSpace,
] as const;

const SPATIAL_STRUCTURE_TYPE_SET = new Set<IfcTypeEnum>(SPATIAL_STRUCTURE_TYPE_ENUMS);
const BUILDING_LIKE_SPATIAL_TYPE_SET = new Set<IfcTypeEnum>(BUILDING_LIKE_SPATIAL_TYPE_ENUMS);
const STOREY_LIKE_SPATIAL_TYPE_SET = new Set<IfcTypeEnum>(STOREY_LIKE_SPATIAL_TYPE_ENUMS);
const SPACE_LIKE_SPATIAL_TYPE_SET = new Set<IfcTypeEnum>(SPACE_LIKE_SPATIAL_TYPE_ENUMS);
const SPATIAL_STRUCTURE_TYPE_NAME_SET = new Set<string>(
  SPATIAL_STRUCTURE_TYPE_ENUMS.map((type) => IfcTypeEnumToString(type)),
);

export function isSpatialStructureType(typeEnum: IfcTypeEnum): boolean {
  return SPATIAL_STRUCTURE_TYPE_SET.has(typeEnum);
}

export function isSpatialStructureTypeName(typeName: string | null | undefined): boolean {
  if (!typeName) return false;
  return SPATIAL_STRUCTURE_TYPE_NAME_SET.has(typeName);
}

export function isBuildingLikeSpatialType(typeEnum: IfcTypeEnum): boolean {
  return BUILDING_LIKE_SPATIAL_TYPE_SET.has(typeEnum);
}

export function isStoreyLikeSpatialType(typeEnum: IfcTypeEnum): boolean {
  return STOREY_LIKE_SPATIAL_TYPE_SET.has(typeEnum);
}

export function isStoreyLikeSpatialTypeName(typeName: string | null | undefined): boolean {
  if (!typeName) return false;
  return isStoreyLikeSpatialType(IfcTypeEnumFromString(typeName));
}

export function isSpaceLikeSpatialType(typeEnum: IfcTypeEnum): boolean {
  return SPACE_LIKE_SPATIAL_TYPE_SET.has(typeEnum);
}

export function isSpaceLikeSpatialTypeName(typeName: string | null | undefined): boolean {
  if (!typeName) return false;
  return isSpaceLikeSpatialType(IfcTypeEnumFromString(typeName));
}
