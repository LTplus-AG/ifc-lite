/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { SectionCutter, cutMeshesStreaming } from './section-cutter.js';
import type { SectionPlaneConfig } from './types.js';

function cube(expressId: number): MeshData {
  return { expressId, color: [1, 1, 1, 1], normals: new Float32Array(24),
    positions: new Float32Array([-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1]),
    indices: new Uint32Array([0,1,2, 0,2,3, 4,6,5, 4,7,6, 0,4,5, 0,5,1, 3,2,6, 3,6,7, 0,3,7, 0,7,4, 1,5,6, 1,6,2]),
  };
}

describe('selective section cutting (#8015)', () => {
  it('emits no segments or cap polygons for excluded entities, for sync and streaming cuts', async () => {
    const ids = new Set([101]);
    const meshes = [cube(101), cube(101 + 0x1000000)];
    const config: SectionPlaneConfig = { axis: 'y', position: 0, flipped: false, sectionExcludedIds: ids };
    const cutter = new SectionCutter(config);
    const all = new SectionCutter({ ...config, sectionExcludedIds: undefined }).cutMeshes(meshes);
    expect(all.polygons.length).toBe(2);
    for (const result of [cutter.cutMeshes(meshes), await cutMeshesStreaming(meshes, config, { batchSize: 1 })]) {
      expect(new Set(result.segments.map(s => s.entityId))).toEqual(new Set([101 + 0x1000000]));
      expect(result.polygons.length).toBe(1);
      expect(result.stats.totalTriangles).toBe(12);
    }
    ids.clear();
    expect(cutter.cutMeshes(meshes).polygons.length).toBe(2);
    ids.add(101); ids.add(101 + 0x1000000);
    expect(cutter.cutMeshes(meshes).segments).toEqual([]);
  });
});
