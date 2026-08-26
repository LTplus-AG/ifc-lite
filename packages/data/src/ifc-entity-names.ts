/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * UPPERCASE STEP keyword -> PascalCase entity name.
 *
 * DERIVED AT LOAD from the generated schema, not transcribed. This used to be
 * a hand-maintained literal of 880 entries whose header named a regenerator
 * (`scripts/generate-entity-names.ts`) that has never existed in this
 * repository; 282 entities the schema knows about were missing from it,
 * including `IfcWallElementedCase`, `IfcBuildingElement`, `IfcDoorStyle` and
 * the whole `*StandardCase` family, so every caller doing
 * `IFC_ENTITY_NAMES[upper] ?? upper` displayed the raw UPPERCASE keyword for
 * them. Building the map from `ifc-schema/generated/entities-*.ts` — which
 * `pnpm --filter @ifc-lite/data run generate:ifc-schema` regenerates from the
 * buildingSMART schema dumps — means a schema bump carries the names along and
 * there is no second list to fall behind.
 *
 * `ifc-entity-names.test.ts` pins the result against `IfcTypeEnum`, and
 * `ifc-entity-names.schema-parity.test.ts` pins it against the schema in both
 * directions and by name.
 */

import { ENTITIES_IFC2X3 } from './ifc-schema/generated/entities-ifc2x3.js';
import { ENTITIES_IFC4 } from './ifc-schema/generated/entities-ifc4.js';
import { ENTITIES_IFC4X3 } from './ifc-schema/generated/entities-ifc4x3.js';

/**
 * Names reachable through `IfcTypeEnum` / `IfcTypeEnumToString` but absent from
 * every generated schema array, so they cannot be derived. Kept by name — a
 * fourth one appearing is a schema question, not a line to add here quietly.
 */
const ENUM_ONLY_NAMES = ['IfcSolidStratum', 'IfcVoidStratum', 'IfcWaterStratum'];

function buildEntityNames(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const list of [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]) {
    for (const entity of list) map[entity.name.toUpperCase()] = entity.name;
  }
  for (const name of ENUM_ONLY_NAMES) map[name.toUpperCase()] = name;
  return map;
}

export const IFC_ENTITY_NAMES: Record<string, string> = buildEntityNames();
