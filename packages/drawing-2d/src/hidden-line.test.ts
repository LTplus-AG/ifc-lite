/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { HiddenLineClassifier } from './hidden-line.js';
import type { DrawingLine } from './types.js';

/**
 * A flat quad occluder spanning x/y in [0, 10] at the given world z, viewed
 * down the z axis with the cut at z = 0 (unflipped). The kept half is
 * z in [-maxDepth, 0]; view depth is -z (see projection-bands.ts), so a quad
 * at z = -5 rasterizes at view depth 5. `sampleVisibility` (hidden-line.ts)
 * compares a candidate line's view depth against this depth buffer.
 */
function occluderMesh(z: number = -5): MeshData {
  return {
    expressId: 1,
    positions: new Float32Array([
      0, 0, z,
      10, 0, z,
      10, 10, z,
      0, 10, z,
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
    classifier.buildDepthBuffer([occluderMesh()], { axis: 'z', position: 0, flipped: false }, 10);

    // Occluder sits at view depth 5; a line at view depth 3 is in front.
    const [result] = classifier.classifyLines([makeLine(3)]);
    expect(result.overallVisibility).toBe('visible');
  });

  it('classifies a line farther than the occluder as hidden', () => {
    const classifier = new HiddenLineClassifier({ resolution: 64 });
    classifier.buildDepthBuffer([occluderMesh()], { axis: 'z', position: 0, flipped: false }, 10);

    // A line at view depth 7 sits behind the depth-5 occluder.
    const [result] = classifier.classifyLines([makeLine(7)]);
    expect(result.overallVisibility).toBe('hidden');
  });
});

describe('HiddenLineClassifier with no in-window occluder and no bounds (issue #2639)', () => {
  it('classifies lines visible when nothing rasterizes into the kept half', () => {
    const classifier = new HiddenLineClassifier({ resolution: 64 });
    // The occluder sits at z = 100, far outside the occluder window, and no
    // bounds argument is passed, so the classifier computes bounds itself
    // and finds none. It must degrade to "everything visible", NOT index the
    // buffer with NaN and classify everything hidden.
    classifier.buildDepthBuffer([occluderMesh(100)], { axis: 'z', position: 0, flipped: false }, 10);

    const [result] = classifier.classifyLines([makeLine(3)]);
    expect(result.overallVisibility).toBe('visible');
  });
});

describe('HiddenLineClassifier with a non-zero MeshData.origin (PR #2621)', () => {
  /**
   * A small occluder quad plus one far, degenerate (zero-area) marker vertex.
   * The marker vertex is folded into the bounds scan (which walks vertices
   * directly) but its triangle has zero area, so the rasterizer never writes
   * depth for it. This stretches the *bounding box* used to build the depth
   * buffer's pixel grid far beyond what actually gets rasterized, leaving the
   * region between the quad and the marker at `Infinity` (unwritten) - the
   * same shape as a real building where one occluder sits near one corner of
   * a much larger cut-plane extent.
   *
   * The quad is at LOCAL (0,0,localZ)-(10,10,localZ); `origin` shifts it into
   * WORLD space. The marker sits at LOCAL (100,100,localZ).
   */
  function offsetOccluderMesh(origin: [number, number, number], localZ: number): MeshData {
    return {
      expressId: 1,
      positions: new Float32Array([
        0, 0, localZ,
        10, 0, localZ,
        10, 10, localZ,
        0, 10, localZ,
        100, 100, localZ, // marker vertex - only referenced by a degenerate triangle
      ]),
      normals: new Float32Array(15),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 4, 4]),
      color: [1, 1, 1, 1],
      origin,
    };
  }

  it('classifies a line behind a laterally-offset occluder as hidden (in-plane origin, PR #2621)', () => {
    // Origin shifts the occluder in x/y only - the cut axis (z) is untouched.
    // The quad sits at world z = -5 (view depth 5), inside the kept half of
    // a cut at z = 0.
    const origin: [number, number, number] = [20, 20, 0];
    const classifier = new HiddenLineClassifier({ resolution: 256 });
    classifier.buildDepthBuffer([offsetOccluderMesh(origin, -5)], { axis: 'z', position: 0, flipped: false }, 10);

    // The line is expressed in WORLD coordinates (as edge-extractor produces,
    // post-lift), sitting over the occluder's WORLD footprint (20,20)-(30,30),
    // at view depth 7 - behind the occluder's depth-5 face. If the origin
    // lift regressed, the quad would rasterize over LOCAL (0,0)-(10,10)
    // instead and this line would wrongly stay visible.
    const line: DrawingLine = {
      line: { start: { x: 25, y: 25 }, end: { x: 26, y: 26 } },
      category: 'projection',
      visibility: 'visible',
      entityId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
      depth: 7,
    };

    const [result] = classifier.classifyLines([line]);
    expect(result.overallVisibility).toBe('hidden');
  });

  it('classifies a line behind an occluder offset along the cut axis as hidden (PR #2621)', () => {
    // Origin shifts the occluder along the cut axis (z) - no x/y offset, so
    // this isolates the depth-range bug from the in-plane one above: if the
    // rasterizer's depth-window test runs on the unlifted (local) vertex, the
    // whole occluder mesh falls outside the kept half and NONE of its
    // triangles get rasterized - the depth buffer ends up entirely `Infinity`
    // wherever nothing else wrote to it, not just misaligned in one region.
    //
    // A second, origin-free mesh (`boundsMesh`) supplies two degenerate
    // (zero-area) marker vertices purely to give the depth buffer a
    // non-trivial pixel grid - identical in both the buggy and fixed cases,
    // since it carries no origin - so this test isolates the axis-lift bug
    // instead of exercising the empty-bounds degradation path.
    const origin: [number, number, number] = [0, 0, 50];
    const occluder = offsetOccluderMesh(origin, 5);
    const boundsMesh: MeshData = {
      expressId: 2,
      positions: new Float32Array([
        0, 0, 55,
        100, 100, 55,
      ]),
      normals: new Float32Array(6),
      indices: new Uint32Array([0, 0, 0, 1, 1, 1]), // both triangles degenerate
      color: [1, 1, 1, 1],
    };

    const classifier = new HiddenLineClassifier({ resolution: 256 });
    // World z of the occluder face is 5 + 50 = 55; cut at z = 57 puts the
    // face in the kept half at view depth 57 - 55 = 2. With the origin lift
    // reverted, the face reads as local z = 5 (view depth 52), outside the
    // 10-unit occluder window, and rasterizes nothing.
    classifier.buildDepthBuffer([occluder, boundsMesh], { axis: 'z', position: 57, flipped: false }, 10);

    const line: DrawingLine = {
      line: { start: { x: 5, y: 5 }, end: { x: 6, y: 6 } },
      category: 'projection',
      visibility: 'visible',
      entityId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
      // View depth of the occluder face is 2; a line 3 units farther from
      // the cut plane sits behind it.
      depth: 5,
    };

    const [result] = classifier.classifyLines([line]);
    expect(result.overallVisibility).toBe('hidden');
  });
});
