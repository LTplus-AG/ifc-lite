/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isSpaceLikeSpatialType, type SpatialHierarchy } from '@ifc-lite/data';

/** Match the normal parser's direct containment indexes at every spatial level. */
export function setTexturedProductMembership(hierarchy: SpatialHierarchy, containerId: number,
  objectId: number, present: boolean): void {
  const path = hierarchy.getPath(containerId);
  const node = path.at(-1);
  if (!node || node.expressId !== containerId) throw new Error('The object container is absent from the spatial tree.');
  // These lists normally alias node.elements. Mutate each unique list in place
  // so both live tree consumers and cached per-container indexes stay coherent.
  const lists = new Set([node.elements]);
  for (const map of [hierarchy.byStorey, hierarchy.byBuilding, hierarchy.bySite, hierarchy.bySpace]) {
    const list = map.get(containerId);
    if (list) lists.add(list);
  }
  for (const list of lists) {
    const index = list.indexOf(objectId);
    if (present && index === -1) list.push(objectId);
    else if (!present && index !== -1) list.splice(index, 1);
  }
  if (present) {
    hierarchy.elementToContainer?.set(objectId, containerId);
    // Match the parser's space claim, which follows only consecutive space-like
    // children from a storey. Keep the object's direct container as authored.
    let index = path.length - 1;
    while (index > 0 && isSpaceLikeSpatialType(path[index]!.type)) index--;
    const storeyId = path[index]!.expressId;
    if (hierarchy.byStorey.has(storeyId)) hierarchy.elementToStorey.set(objectId, storeyId);
  } else {
    hierarchy.elementToContainer?.delete(objectId);
    hierarchy.elementToStorey.delete(objectId);
  }
}
