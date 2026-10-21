/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcAPI } from '@ifc-lite/wasm';

/** Shared Node/browser observer of the real canonical pre-pass/batch path. */
export function meshMepFixture(api: IfcAPI, source: string) {
  const bytes = new TextEncoder().encode(source);
  try {
    const pre = api.buildPrePassOnce(bytes);
    const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale,
      pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      const results = [];
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) throw new Error(`Missing mesh ${i}`);
        try {
          const positions = mesh.positions;
          const indices = mesh.indices;
          const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
          for (let j = 0; j < positions.length; j += 3) {
            for (let axis = 0; axis < 3; axis++) {
              bounds[axis] = Math.min(bounds[axis], positions[j + axis]);
              bounds[axis + 3] = Math.max(bounds[axis + 3], positions[j + axis]);
            }
          }
          let volume = 0;
          for (let j = 0; j < indices.length; j += 3) {
            const a = indices[j] * 3, b = indices[j + 1] * 3, c = indices[j + 2] * 3;
            volume += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
              + positions[a + 1] * (positions[b + 2] * positions[c] - positions[b] * positions[c + 2])
              + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
          }
          results.push({ expressId: mesh.expressId, triangles: indices.length / 3, volume: Math.abs(volume / 6), bounds });
        } finally { mesh.free(); }
      }
      return results;
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); }
}
