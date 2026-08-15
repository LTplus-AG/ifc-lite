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

describe('HiddenLineClassifier with a non-zero MeshData.origin', () => {
  /**
   * A small occluder quad plus one far, degenerate (zero-area) marker vertex.
   * The marker vertex is folded into `computeBounds`'s scan (which walks
   * vertices directly) but its triangle has zero area, so `rasterizeTriangle`
   * never writes depth for it. This stretches the *bounding box* used to
   * build the depth buffer's pixel grid far beyond what actually gets
   * rasterized, leaving the region between the quad and the marker at
   * `Infinity` (unwritten) — the same shape as a real building where one
   * occluder sits near one corner of a much larger cut-plane extent.
   *
   * The quad is at LOCAL (0,0,5)-(10,10,5); `origin` shifts it to WORLD
   * (20,20,5)-(30,30,5). The marker sits at LOCAL (100,100,5) / WORLD
   * (120,120,5).
   */
  function offsetOccluderMesh(origin: [number, number, number]): MeshData {
    return {
      expressId: 1,
      positions: new Float32Array([
        0, 0, 5,
        10, 0, 5,
        10, 10, 5,
        0, 10, 5,
        100, 100, 5, // marker vertex — only referenced by a degenerate triangle
      ]),
      normals: new Float32Array(15),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 4, 4]),
      color: [1, 1, 1, 1],
      origin,
    };
  }

  it('classifies a line behind a laterally-offset occluder as hidden (in-plane origin)', () => {
    // Origin shifts the occluder in x/y only — the cut axis (z) is untouched.
    const origin: [number, number, number] = [20, 20, 0];
    const classifier = new HiddenLineClassifier({ resolution: 256 });
    classifier.buildDepthBuffer([offsetOccluderMesh(origin)], 'z', 0, 10, false);

    // The line is expressed in WORLD coordinates (as edge-extractor now
    // produces, post-lift), sitting over the occluder's WORLD footprint
    // (20,20)-(30,30), at depth 7 — behind the occluder's depth-5 face.
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

  it('classifies a line behind an occluder offset along the cut axis as hidden', () => {
    // Origin shifts the occluder along the cut axis (z) — no x/y offset, so
    // this isolates the depth-range bug from the in-plane one above: if the
    // rasterizer's depth-range test runs on the unlifted (local) vertex, the
    // whole occluder mesh falls outside [sectionPosition, sectionPosition +
    // maxDepth) and NONE of its triangles get rasterized — the depth buffer
    // ends up entirely `Infinity` wherever nothing else wrote to it, not just
    // misaligned in one region.
    //
    // A second, origin-free mesh (`boundsMesh`) supplies two degenerate
    // (zero-area) marker vertices purely to give the depth buffer a
    // non-trivial pixel grid — identical in both the buggy and fixed cases,
    // since it carries no origin — so this test isolates the axis-lift bug
    // instead of exercising the buffer's degenerate 1x1 fallback.
    const origin: [number, number, number] = [0, 0, 50];
    const occluder = offsetOccluderMesh(origin);
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
    // World z of the occluder face is 5 + 50 = 55; section the plane there.
    classifier.buildDepthBuffer([occluder, boundsMesh], 'z', 55, 10, false);

    const line: DrawingLine = {
      line: { start: { x: 5, y: 5 }, end: { x: 6, y: 6 } },
      category: 'projection',
      visibility: 'visible',
      entityId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
      // World depth of the occluder face is 55 - 55 = 0; a line 3 units
      // farther along the cut axis sits behind it.
      depth: 3,
    };

    const [result] = classifier.classifyLines([line]);
    expect(result.overallVisibility).toBe('hidden');
  });
});
