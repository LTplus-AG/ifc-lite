/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The physical side of the axis-drift check (#9668): where each beam, column
 * and member's analytical line should be, by the derivation's own rule (its
 * straight Axis representation, else the idealised extrusion; see
 * `structural-derive-types.ts`). Pass the result to `structuralConsistencyIssues`
 * in `@ifc-lite/parser` as `physicalAxes`.
 *
 * Reads the parsed file, as that check does: edits held in a mutation view
 * are not applied. To check an edited model, export it and parse the result.
 */

import { iterateEffectiveEntityIds, MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { expandTypes, type IfcDataStore, type StructuralLine } from '@ifc-lite/parser';
import { safeLengthUnitScale } from './length-unit-scale.js';
import { createStyleEntityReader, type StyleEntity } from './style-entity-reader.js';
import { idealiseLine } from './structural-derive-idealise.js';
import { readElementShape } from './structural-derive-shape.js';

/** The classes the derivation idealises as curve members; subtypes included. */
const CURVE_CLASSES = ['IFCBEAM', 'IFCCOLUMN', 'IFCMEMBER'];

/** Each curve element's analytical line in IFC world metres, by express id. Elements with no readable line are left out. */
export function structuralPhysicalAxes(store: IfcDataStore): Map<number, StructuralLine> {
  const view = new MutablePropertyView(null, '__structural-checks__');
  const live = createStyleEntityReader(store, new StoreEditor(store, view));
  // Members share placements and profiles: parse each record once.
  const cache = new Map<number, StyleEntity | null>();
  const reader = {
    entity: (id: number) => {
      if (!cache.has(id)) cache.set(id, live(id));
      return cache.get(id)!;
    },
  };
  const metres = store.source.byteLength > 0 ? safeLengthUnitScale(store.source, store.entityIndex, 'structuralPhysicalAxes') ?? 1 : 1;
  const axes = new Map<number, StructuralLine>();
  for (const { expressId } of iterateEffectiveEntityIds(store, view, expandTypes(CURVE_CLASSES, store.schemaVersion))) {
    const shape = readElementShape(reader, expressId, metres, true);
    if (shape.axis) {
      axes.set(expressId, shape.axis);
      continue;
    }
    const line = shape.prism && idealiseLine(shape.prism);
    if (line && !('issue' in line)) axes.set(expressId, [line.start, line.end]);
  }
  return axes;
}
