/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { createElementFieldReader } from './charts/element-field-reader.js';

/** Metre elevations for the storeys in a live level-display grouping. */
export function effectiveLevelElevations(
  store: IfcDataStore,
  view: MutablePropertyView,
  storeyIds: Iterable<number>,
): Map<number, number> {
  const out = new Map<number, number>();
  const reader = createElementFieldReader(store, view);
  const scale = store.lengthUnitScale ?? 1;
  for (const id of storeyIds) {
    const edited = view.getAttributeMutationsForEntity(id)
      .find((mutation) => mutation.name === 'Elevation')?.value;
    const authored = view.getNewEntity(id)
      ? reader.read(id, { kind: 'attribute', attributeName: 'Elevation', valueKind: 'category' })
      : undefined;
    const raw = edited ?? authored;
    if (raw !== undefined && raw !== null && raw !== '' && Number.isFinite(Number(raw))) {
      out.set(id, Number(raw) * scale);
      continue;
    }
    const source = store.spatialHierarchy?.storeyElevations.get(id);
    if (source !== undefined) out.set(id, source);
  }
  return out;
}
