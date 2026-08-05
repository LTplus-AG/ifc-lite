/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { HiddenLineClassifier } from './hidden-line.js';
import type { DrawingLine } from './types.js';

/**
 * A flat quad occluder at z=5, spanning x/y in [0, 10], viewed along the
 * z axis. `sampleVisibility` (hidden-line.ts) compares a candidate line's
 * depth against this rasterized depth buffer.
 */
function occluderMesh(): MeshData {
  return {
    expressId: 1,
    positions: new Float32Array([
      0, 0, 5,
      10, 0, 5,
      10, 10, 5,
      0, 10, 5,
    ]),
    normals: new Float32Array(12),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [1, 1, 1, 1],
  };
}

function makeLine(depth: number): DrawingLine {
  return {
    line: { start: { x: 2, y: 2 }, end: { x: 8, y: 8 } },
    category: 'projection',
    visibility: 'visible',
    entityId: 1,
    ifcType: 'IfcWall',
    modelIndex: 0,
    depth,
  };
}

describe('HiddenLineClassifier depth test (sampleVisibility)', () => {
  it('classifies a line nearer than the occluder as visible', () => {
    const classifier = new HiddenLineClassifier({ resolution: 64 });
    classifier.buildDepthBuffer([occluderMesh()], 'z', 0, 10, false);

    // Occluder sits at depth 5; a line at depth 3 is in front of it.
    const [result] = classifier.classifyLines([makeLine(3)]);
    expect(result.overallVisibility).toBe('visible');
  });

  it('classifies a line farther than the occluder as hidden', () => {
    const classifier = new HiddenLineClassifier({ resolution: 64 });
    classifier.buildDepthBuffer([occluderMesh()], 'z', 0, 10, false);

    // A line at depth 7 sits behind the depth-5 occluder.
    const [result] = classifier.classifyLines([makeLine(7)]);
    expect(result.overallVisibility).toBe('hidden');
  });
});
