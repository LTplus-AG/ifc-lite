/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcStoreBase as IfcDataStore } from '@ifc-lite/data';
import { normalizeIfcTypeName } from '@ifc-lite/parser';

/**
 * The raw STEP class token off an entity-index entry.
 *
 * `IfcStoreBase` types the index values as `unknown` on purpose — the ref shape
 * belongs to the parser — so this narrows structurally rather than casting.
 */
function rawTypeOf(ref: unknown): string | undefined {
  if (ref === null || typeof ref !== 'object' || !('type' in ref)) return undefined;
  const { type } = ref as { type: unknown };
  return typeof type === 'string' ? type : undefined;
}

/**
 * An entity's IFC class in canonical PascalCase.
 *
 * `store.entities` indexes products, so it holds no row for an
 * `IfcPropertySet`, `IfcElementQuantity`, `IfcRelDefinesByProperties` or
 * `IfcRelAssociatesMaterial`, and `getTypeName` answers `'Unknown'` for all
 * four — while the parsed entity index knew the class the whole time, as the
 * raw uppercase STEP token. `'Unknown'` is the value callers key passes on, so
 * iterating a model's classes by it silently skips every entity of those
 * classes.
 *
 * Its own `rawTypeName` fallback cannot cover this, because for these entities
 * the table has no row at all to fall back within.
 *
 * Normalising through `normalizeIfcTypeName` rather than a name map keeps the
 * answer correct for classes outside any single curated table — the same
 * reasoning that moved `isProductType` off `IfcTypeEnum`. Handing back the raw
 * uppercase token would just be a second wrong answer.
 */
export function resolveEntityTypeName(store: IfcDataStore, expressId: number): string {
  const fromTable = store.entities.getTypeName(expressId);
  if (fromTable !== 'Unknown') return fromTable;
  const raw = rawTypeOf(store.entityIndex.byId.get(expressId));
  return raw === undefined ? fromTable : normalizeIfcTypeName(raw);
}
