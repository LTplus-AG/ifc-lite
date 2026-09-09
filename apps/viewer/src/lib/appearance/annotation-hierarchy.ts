/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SpatialHierarchy } from '@ifc-lite/data';

/** Match the normal parser's direct containment indexes at every spatial level. */
export function setAnnotationMembership(hierarchy: SpatialHierarchy, containerId: number,
  annotationId: number, present: boolean): void {
  const node = hierarchy.getPath(containerId).at(-1);
  if (!node || node.expressId !== containerId) throw new Error('The annotation container is absent from the spatial tree.');
  // These lists normally alias node.elements. Mutate each unique list in place
  // so both live tree consumers and cached per-container indexes stay coherent.
  const lists = new Set([node.elements]);
  for (const map of [hierarchy.byStorey, hierarchy.byBuilding, hierarchy.bySite, hierarchy.bySpace]) {
    const list = map.get(containerId);
    if (list) lists.add(list);
  }
  for (const list of lists) {
    const index = list.indexOf(annotationId);
    if (present && index === -1) list.push(annotationId);
    else if (!present && index !== -1) list.splice(index, 1);
  }
  if (present) {
    hierarchy.elementToContainer?.set(annotationId, containerId);
    // This index is direct storey containment, not the nearest ancestor. Space
    // and building containment must not invent a storey entry on authored load.
    if (hierarchy.byStorey.has(containerId)) hierarchy.elementToStorey.set(annotationId, containerId);
  } else {
    hierarchy.elementToContainer?.delete(annotationId);
    hierarchy.elementToStorey.delete(annotationId);
  }
}
