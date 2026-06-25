/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractAllEntityAttributes, type IfcDataStore } from '@ifc-lite/parser';

/**
 * Pick the `PredefinedType` value out of the schema-named attribute pairs
 * returned by {@link extractAllEntityAttributes}. The extractor already strips
 * the STEP enum markers (`.FLOOR.` → `FLOOR`), so this returns the display
 * token (e.g. `"FLOOR"`, `"FLOORING"`, `"USERDEFINED"`, `"NOTDEFINED"`).
 * Returns `undefined` when the slot is absent or empty so callers can ghost /
 * skip elements that carry no PredefinedType.
 */
export function pickPredefinedType(
  attrs: ReadonlyArray<{ name: string; value: string | number | boolean }>,
): string | undefined {
  const entry = attrs.find((a) => a.name === 'PredefinedType');
  if (!entry) return undefined;
  const value = String(entry.value).trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Resolve an entity's IFC `PredefinedType` (e.g. `IfcSlab.FLOOR`,
 * `IfcCovering.FLOORING`) from the source buffer. Schema-driven, so it works
 * for any product type whose attribute layout the registry knows. (#1364)
 *
 * Like `Tag` and the property / quantity auto-color sources, this re-parses
 * the entity on demand — there is no columnar PredefinedType accessor — which
 * is the same cost class as those existing per-entity attribute reads.
 */
export function resolveEntityPredefinedType(
  store: IfcDataStore,
  expressId: number,
): string | undefined {
  if (!(store.source?.length > 0) || !store.entityIndex) return undefined;
  return pickPredefinedType(extractAllEntityAttributes(store, expressId));
}
