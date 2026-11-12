/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The physical side of the axis-drift check (#9668): where each beam, column
 * and member's analytical line should be, by the derivation's own rule
 * (`curveElementLine`). Pass the result to `structuralConsistencyIssues` in
 * `@ifc-lite/parser` as `physicalAxes`.
 *
 * Reads the parsed file, as that check does: the editor below carries an
 * empty view only because the shape reader takes one. To check an edited
 * model, export it and parse the result.
 */

import { iterateEffectiveEntityIds, MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { expandTypes, type IfcDataStore, type StructuralLine } from '@ifc-lite/parser';
import { shapeReader } from './structural-derive-facts.js';
import { curveElementLine } from './structural-derive-idealise.js';
import { CURVE } from './structural-derive-plan.js';
import { readElementShape } from './structural-derive-shape.js';

/** Each curve element's analytical line in IFC world metres, by express id. Elements with no readable line are left out. */
export function structuralPhysicalAxes(store: IfcDataStore): Map<number, StructuralLine> {
  if (store.schemaVersion === 'IFC5') throw new Error('structuralPhysicalAxes: IFC5 is not supported; use IFC2X3, IFC4 or IFC4X3');
  const view = new MutablePropertyView(null, '__structural-checks__');
  const { reader, metres } = shapeReader(store, new StoreEditor(store, view), 'structuralPhysicalAxes');
  const axes = new Map<number, StructuralLine>();
  for (const { expressId } of iterateEffectiveEntityIds(store, view, expandTypes([...CURVE], store.schemaVersion))) {
    const line = curveElementLine(readElementShape(reader, expressId, metres, true));
    if (!('issue' in line)) axes.set(expressId, [line.start, line.end]);
  }
  return axes;
}
