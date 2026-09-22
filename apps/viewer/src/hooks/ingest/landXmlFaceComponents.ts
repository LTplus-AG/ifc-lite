/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LandXmlTinSurface } from './landXmlSemantics.js';

/** Partition faces by shared source vertices without copying surface payloads. */
export function connectedFaceComponents(
  faces: LandXmlTinSurface['faces'],
): Array<LandXmlTinSurface['faces']> {
  const byPoint = new Map<string, number[]>();
  faces.forEach((face, index) => face.forEach((point) => {
    const indexes = byPoint.get(point) ?? [];
    indexes.push(index);
    byPoint.set(point, indexes);
  }));
  const visited = new Uint8Array(faces.length);
  const components: Array<LandXmlTinSurface['faces']> = [];
  for (let start = 0; start < faces.length; start++) {
    if (visited[start]) continue;
    const component: LandXmlTinSurface['faces'] = [];
    const pending = [start];
    const processed = new Set<string>();
    visited[start] = 1;
    while (pending.length > 0) {
      const face = faces[pending.pop()!];
      component.push(face);
      for (const point of face) {
        if (processed.has(point)) continue;
        processed.add(point);
        for (const neighbour of byPoint.get(point) ?? []) {
          if (!visited[neighbour]) { visited[neighbour] = 1; pending.push(neighbour); }
        }
      }
    }
    components.push(component);
  }
  return components;
}
