/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * UPPERCASE STEP keyword -> PascalCase entity name.
 *
 * GENERATED, not transcribed. This used to be a hand-maintained literal of 880
 * entries whose header named a regenerator (`scripts/generate-entity-names.ts`)
 * that has never existed in this repository; 282 keys the schema knows about
 * were missing from it, including `IfcWallElementedCase`, `IfcBuildingElement`,
 * `IfcDoorStyle` and every `*StandardCase` but `IfcWallStandardCase`, so every
 * caller doing `IFC_ENTITY_NAMES[upper] ?? upper` displayed the raw UPPERCASE
 * keyword for them. `scripts/emit-entity-names.ts` now writes the map from the
 * `entities-*.ts` tables that `generate:ifc-schema` produces from the
 * buildingSMART dumps, in the same command, so a schema bump carries the names
 * along and there is no second list to fall behind.
 *
 * It is emitted as a literal rather than built at load from the `ENTITIES_*`
 * arrays because a runtime loop over those is not tree-shakable: it would keep
 * all three — ~630 KB minified, ~57 KB gzipped — in every bundle that touches a
 * name lookup, and `@ifc-lite/data` is published for browser consumers.
 *
 * `ifc-entity-names.test.ts` pins the result against `IfcTypeEnum`, and
 * `ifc-entity-names.schema-parity.test.ts` pins it against `entities-*.ts` in
 * both directions and by name — so a stale generated file, the failure mode a
 * committed artefact introduces, fails there rather than degrading display
 * names silently.
 */

export { IFC_ENTITY_NAMES } from './ifc-schema/generated/entity-names.js';
