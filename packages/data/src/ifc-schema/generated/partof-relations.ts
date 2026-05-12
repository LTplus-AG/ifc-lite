/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Auto-generated from `scripts/upstream/SchemaInfo.*.g.cs` (buildingSMART/
 * IDS-Audit-tool, MIT). Do not edit by hand — regenerate via
 *   pnpm --filter @ifc-lite/data run generate:ifc-schema
 */


import type { PartOfRelationInfo } from '../types.js';

export const PART_OF_RELATIONS_IFC2X3: readonly PartOfRelationInfo[] = [
  { relation: "IFCRELAGGREGATES", owner: "IFCOBJECTDEFINITION", member: "IFCOBJECTDEFINITION" },
  { relation: "IFCRELASSIGNSTOGROUP", owner: "IFCGROUP", member: "IFCOBJECTDEFINITION" },
  { relation: "IFCRELCONTAINEDINSPATIALSTRUCTURE", owner: "IFCSPATIALSTRUCTUREELEMENT", member: "IFCPRODUCT" },
  { relation: "IFCRELNESTS", owner: "IFCOBJECTDEFINITION", member: "IFCOBJECTDEFINITION" },
  { relation: "IFCRELVOIDSELEMENT", owner: "IFCELEMENT", member: "IFCFEATUREELEMENTSUBTRACTION" },
  { relation: "IFCRELFILLSELEMENT", owner: "IFCOPENINGELEMENT", member: "IFCELEMENT" },
];

export const PART_OF_RELATIONS_IFC4: readonly PartOfRelationInfo[] = [
  { relation: "IFCRELAGGREGATES", owner: "IFCOBJECTDEFINITION", member: "IFCOBJECTDEFINITION" },
  { relation: "IFCRELASSIGNSTOGROUP", owner: "IFCGROUP", member: "IFCOBJECTDEFINITION" },
  { relation: "IFCRELCONTAINEDINSPATIALSTRUCTURE", owner: "IFCSPATIALELEMENT", member: "IFCPRODUCT" },
  { relation: "IFCRELNESTS", owner: "IFCOBJECTDEFINITION", member: "IFCOBJECTDEFINITION" },
  { relation: "IFCRELVOIDSELEMENT", owner: "IFCELEMENT", member: "IFCFEATUREELEMENTSUBTRACTION" },
  { relation: "IFCRELFILLSELEMENT", owner: "IFCOPENINGELEMENT", member: "IFCELEMENT" },
];

export const PART_OF_RELATIONS_IFC4X3: readonly PartOfRelationInfo[] = [
  { relation: "IFCRELAGGREGATES", owner: "IFCOBJECTDEFINITION", member: "IFCOBJECTDEFINITION" },
  { relation: "IFCRELASSIGNSTOGROUP", owner: "IFCGROUP", member: "IFCOBJECTDEFINITION" },
  { relation: "IFCRELCONTAINEDINSPATIALSTRUCTURE", owner: "IFCSPATIALELEMENT", member: "IFCPRODUCT" },
  { relation: "IFCRELNESTS", owner: "IFCOBJECTDEFINITION", member: "IFCOBJECTDEFINITION" },
  { relation: "IFCRELVOIDSELEMENT", owner: "IFCELEMENT", member: "IFCFEATUREELEMENTSUBTRACTION" },
  { relation: "IFCRELFILLSELEMENT", owner: "IFCOPENINGELEMENT", member: "IFCELEMENT" },
];
