/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Starter IFC type catalog used as a dropdown fallback when the active
 * model's `entityIndex.byType` isn't yet populated (e.g. server-loaded
 * stores without the on-demand maps). Once a model is loaded, the
 * filter-schema layer surfaces only the types actually present so users
 * don't waste time picking IfcBeam from a house model that doesn't have
 * one.
 */
export const COMMON_IFC_TYPES: readonly string[] = [
  'IfcWall',
  'IfcWallStandardCase',
  'IfcSlab',
  'IfcBeam',
  'IfcColumn',
  'IfcDoor',
  'IfcWindow',
  'IfcRoof',
  'IfcStair',
  'IfcStairFlight',
  'IfcRailing',
  'IfcRamp',
  'IfcSpace',
  'IfcCovering',
  'IfcCurtainWall',
  'IfcFooting',
  'IfcPlate',
  'IfcMember',
  'IfcOpeningElement',
  'IfcBuildingElementProxy',
  'IfcFurnishingElement',
  'IfcDistributionElement',
];
