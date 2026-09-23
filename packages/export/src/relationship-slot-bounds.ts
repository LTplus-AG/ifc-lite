/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-slot lower-bound reader `filterHiddenRefsFromRelationshipLine`
 * (`reference-collector.ts`) uses to hold a narrowed `STYLE_RESCUE_TYPES`
 * list to its OWN declared cardinality — the same defect shape
 * `nonrel-positional-ref-narrowing.ts`'s `readAggregateSlot` already fixed
 * for non-relationship lines (#5181), closed here for the rescued-style /
 * texture-map path (#5262).
 *
 * `IfcTextureMap.Vertices` is `LIST [3:?] OF IfcTextureVertex`.
 * `filterHiddenRefsFromRelationshipLine`'s list-narrowing assumed a `[1:?]`
 * lower bound: dropping one excluded vertex out of three narrowed a valid
 * 3-vertex list to a 2-vertex one — syntactically well-formed STEP, but a
 * DIFFERENT invalid file than the dangling `#N` it replaced, since the
 * schema requires at least three.
 *
 * Split into its own file rather than folded into `reference-collector.ts`,
 * which that file's own header already documents as sitting at its
 * recorded module-size budget, and rather than reusing
 * `nonrel-positional-ref-narrowing.ts`'s `readAggregateSlot`, whose lookup
 * is keyed off `NONREL_REF_LIST_REGISTRY_NAMES` — a map scoped to the types
 * that qualify for THAT file's own narrowing rule. `STYLE_RESCUE_TYPES` is
 * a different, independently-defined type set (`style-closure.ts`), so this
 * reads the general `ENTITY_REGISTRY_NAMES` map (`registry-entity-names.ts`)
 * instead of borrowing a gate built for an unrelated rule.
 *
 * Reads the declaration from the generated schema registry
 * (`@ifc-lite/parser`'s `getSchemaRegistryForVersion`, keyed by the SOURCE
 * line's own schema version) rather than a hand-written table, so the
 * answer can never drift from the schema it describes.
 */
import { getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';
import { ENTITY_REGISTRY_NAMES } from './registry-entity-names.js';
import type { IfcSchemaVersion } from './schema-converter.js';

function isRegistryVersion(version: IfcSchemaVersion): version is SchemaVersionWithRegistry {
  return version === 'IFC2X3' || version === 'IFC4' || version === 'IFC4X3';
}

/**
 * The declared lower bound of the aggregate attribute at `slotIndex` of
 * `entityType`, as `schemaVersion`'s generated registry declares it.
 *
 * `undefined` when it cannot be read (an entity/schema version this file
 * does not cover, a slot index the registry has no attribute for, a slot
 * that is not an aggregate at all, or an aggregate with no declared bound)
 * — the caller's safe default is to apply its EXISTING narrowing rule
 * unmodified, since this reader only ever adds a constraint on top of that
 * rule, never replaces it.
 */
export function readRelationshipSlotLowerBound(
  entityType: string,
  slotIndex: number,
  schemaVersion: IfcSchemaVersion,
): number | undefined {
  if (!isRegistryVersion(schemaVersion)) return undefined;
  const registryName = ENTITY_REGISTRY_NAMES.get(entityType);
  if (registryName === undefined) return undefined;
  const attr = getSchemaRegistryForVersion(schemaVersion).entities[registryName]?.allAttributes?.[slotIndex];
  if (attr === undefined || !(attr.isList || attr.isSet)) return undefined;
  const lowerBound = attr.arrayBounds?.[0];
  if (lowerBound === undefined || !Number.isFinite(lowerBound)) return undefined;
  return lowerBound;
}
