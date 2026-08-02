/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';

/**
 * Cheap presence check against the data store's type index — true if the store
 * contains at least one entity of any of the given IFC types.
 *
 * `entityIndex.byType` indexes EVERY parsed entity (it backs on-demand
 * extraction), so absence here is authoritative: a model with no `IfcAlignment`
 * truly has none. Keys are the raw IFC type strings, which are UPPERCASE in
 * STEP files but can be mixed-case on some cache-load paths, so we check both.
 *
 * Used to skip the always-on full-source WASM scans (`parseAlignmentLines`,
 * `parseGridLines`, `parseSymbolicRepresentations`) on models that have none of
 * the relevant entities — those scans copy the entire IFC source into the WASM
 * heap (hundreds of ms on a 170MB file) on the main thread during load, purely
 * to find nothing.
 *
 * Returns `true` (i.e. do NOT skip) when the index is missing/empty, so gating
 * can never drop real data — worst case is the pre-existing behaviour.
 */
export function hasEntityType(store: IfcDataStore, ...types: string[]): boolean {
  const byType = store.entityIndex?.byType;
  if (!byType || byType.size === 0) return true;
  for (const t of types) {
    if ((byType.get(t.toUpperCase())?.length ?? 0) > 0) return true;
    if ((byType.get(t)?.length ?? 0) > 0) return true;
  }
  return false;
}
