/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcTypeEnumFromString, isSpaceLikeSpatialType } from '@ifc-lite/data';
import { isPhysicalObjectType } from '@/lib/physical-objects';

/**
 * Which classes the product-oriented trees ("By Class", "By Type") may list.
 *
 * The count of objects and the set of rows are two different questions, and
 * this answers the second one. `isPhysicalObjectType` answers the first — it
 * is the schema rule (`IfcElement`, minus feature and virtual elements) that
 * decides what a badge labelled "objects" may count, and it stays the single
 * definition of that; see `lib/physical-objects.ts`.
 *
 * Two classes are shown without being counted as objects, each for a reason
 * the user would give back if we removed the row:
 *
 * - `IfcAnnotation` — a dimension line or tag the user can see in 3D and must
 *   be able to select and hide (issue #1480). It is a drafting aid, never an
 *   object.
 * - Space-like spatial containers — an `IfcSpace` renders, and an authored one
 *   is deliberately folded into this tree, so it must remain findable. It is a
 *   spatial element by schema, so it is not an object either.
 *
 * Everything else that is not a physical object — `IfcGroup`, `IfcZone`,
 * `IfcSystem`, the `IfcProject`/`IfcSite`/`IfcBuilding`/`IfcBuildingStorey`
 * chain, property sets, relationship objects — is not listed here at all. The
 * Groups tab is where groups, zones and systems belong, and the spatial tab is
 * where the chain belongs.
 */
export function isProductTreeClass(typeName: string): boolean {
  if (isPhysicalObjectType(typeName)) return true;
  const enumType = IfcTypeEnumFromString(typeName);
  if (isSpaceLikeSpatialType(enumType)) return true;
  return typeName.toUpperCase() === 'IFCANNOTATION';
}
