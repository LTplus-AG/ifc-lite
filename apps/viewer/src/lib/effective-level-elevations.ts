/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { effectiveStoreyElevation } from '@ifc-lite/create';

/**
 * Metre elevations for the storeys in a live level-display grouping. An
 * edited or authored storey reads through the canonical live elevation
 * (named and positional Elevation edits, storeys added this session, #9013);
 * an untouched one keeps its parsed elevation, and one the parse never
 * placed stays absent.
 */
export function effectiveLevelElevations(
  store: IfcDataStore,
  view: MutablePropertyView,
  storeyIds: Iterable<number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const id of storeyIds) {
    const touched = view.getNewEntity(id) !== undefined
      || view.getAttributeMutationsForEntity(id).length > 0
      || (view.getPositionalMutationsForEntity(id)?.size ?? 0) > 0;
    if (touched) {
      out.set(id, effectiveStoreyElevation(store, view, id));
      continue;
    }
    const source = store.spatialHierarchy?.storeyElevations.get(id);
    if (source !== undefined) out.set(id, source);
  }
  return out;
}
