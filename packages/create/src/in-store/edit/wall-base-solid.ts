/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeometryEntityReader } from '../host-geometry-frame.js';
import { refId } from '../host-geometry-frame.js';
export const ROOF_ATTACHMENT = 'IfcLite_RoofAttachment';
/** Only our recorded roof cuts expose an editable base extrusion. Never unwrap arbitrary imported CSG. */
export function wallBaseSolid(reader: GeometryEntityReader, view: MutablePropertyView | null | undefined, wallId: number, root: number | null): number | null {
  if (root === null || view?.getPropertyValue(wallId, ROOF_ATTACHMENT, 'Clipped') !== true) return root;
  const visited = new Set<number>();
  let id: number | null = root;
  while (id !== null) {
    if (visited.has(id)) return null;
    visited.add(id);
    const entity = reader.entity(id);
    if (entity?.type.toUpperCase() !== 'IFCBOOLEANRESULT') return id;
    if (entity.attributes[0] !== '.DIFFERENCE.' && entity.attributes[0] !== 'DIFFERENCE') return null;
    id = refId(entity.attributes[1]);
  }
  return null;
}
