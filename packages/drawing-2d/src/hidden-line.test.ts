/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { HiddenLineClassifier } from './hidden-line.js';
import { mergeDrawingLines } from './line-merger.js';
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

describe('HiddenLineClassifier out-of-raster samples (no bounds argument)', () => {
  /**
   * A sloped quad STRADDLING the cut plane: z = 5 - y over x,y in [0, 10],
   * so the y = 0 edge (z = +5) is above the cut (cut away) and the y = 10
   * edge (z = -5) is in the kept half. `computeOccluderBounds` walks
   * vertices only and keeps just the two in-window ones (y = 10), so the
   * self-computed raster bounds collapse to a sliver along the y = 10 edge.
   */
  function straddlingSlopedQuad(): MeshData {
    return {
      expressId: 1,
      positions: new Float32Array([
        0, 0, 5,
        10, 0, 5,
        10, 10, -5,
        0, 10, -5,
      ]),
      normals: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      color: [1, 1, 1, 1],
    };
  }

  it('classifies a line outside the raster as visible instead of clamping onto border pixels', () => {
    const classifier = new HiddenLineClassifier({ resolution: 1024 });
    // No bounds argument: the classifier computes bounds itself, which
    // collapse to the sliver described above. The sliver still rasterizes
    // finite depths (about 4.9 at its lower border).
    classifier.buildDepthBuffer([straddlingSlopedQuad()], { axis: 'z', position: 0, flipped: false }, 10);

    // A line at y = 2 sits under the CUT-AWAY part of the quad (z = +3
    // there): nothing occludes it, so it must be visible. Clamping its
    // samples onto the sliver's border row (view depth ~4.9) would wrongly
    // classify this depth-7 line hidden.
    const line: DrawingLine = {
      line: { start: { x: 2, y: 2 }, end: { x: 8, y: 2 } },
      category: 'projection',
      visibility: 'visible',
      entityId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
      depth: 7,
    };

    const [result] = classifier.classifyLines([line]);
    expect(result.overallVisibility).toBe('visible');
  });
});

describe('HiddenLineClassifier per-sample depth lerp (depthEnd, issue #2639)', () => {
  it('splits a depth-sloped line where it crosses the occluder depth', () => {
    // Flat occluder at view depth 5 over x,y in [0, 10]. The line runs from
    // (1, 5) at view depth 2 (in front) to (9, 5) at view depth 7 (behind):
    // depth(t) = 2 + 5t crosses the occluder at t = 0.6, i.e. x = 5.8. A
    // lerp bug (swapped endpoints, or depthEnd ignored) moves or removes
    // the split entirely.
    const classifier = new HiddenLineClassifier({ resolution: 256, samplesPerLine: 100 });
    classifier.buildDepthBuffer([occluderMesh()], { axis: 'z', position: 0, flipped: false }, 10);

    const line: DrawingLine = {
      line: { start: { x: 1, y: 5 }, end: { x: 9, y: 5 } },
      category: 'projection',
      visibility: 'visible',
      entityId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
      depth: 2,
      depthEnd: 7,
    };

    const [result] = classifier.classifyLines([line]);
    expect(result.overallVisibility).toBe('partial');
    expect(result.segments).toHaveLength(2);
    // Near end visible, far end hidden - in that order.
    expect(result.segments[0].visible).toBe(true);
    expect(result.segments[1].visible).toBe(false);
    // The split must land at the geometric crossing x = 5.8, within about
    // one sample spacing (8 units / 100 samples = 0.08).
    expect(Math.abs(result.segments[0].end.x - 5.8)).toBeLessThanOrEqual(0.1);
    expect(result.segments[1].start.x).toBe(result.segments[0].end.x);
    expect(result.segments[0].end.y).toBe(5);
  });
});

describe('applyVisibility split-segment depths (PR #2644 review)', () => {
  // The reviewer's end-to-end reproduction: a flat occluder at view depth 5
  // over x,y in [0, 10]; L1 runs (0,5)->(6,5) with depth 7 -> 2 and L2
  // continues (6,5)->(10,5) at constant depth 2. L1's depth crosses the
  // occluder at t = 0.4 (x = 2.4); sampled at 100, the transition lands at
  // t = 0.395 (x = 2.37), where the lerped view depth is 5.025. Before the
  // fix, applyVisibility spread L1's ORIGINAL depth pair (7, 2) onto both
  // split halves, and mergeDrawingLines then faithfully propagated the stale
  // 7 onto a merged VISIBLE line spanning [2.37, 10] - self-contradictory
  // output, since the occluder covering x = 2.37 sits at depth 5.
  function reviewerLines(): [DrawingLine, DrawingLine] {
    const base = {
      category: 'projection' as const,
      visibility: 'visible' as const,
      entityId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
    };
    return [
      { ...base, line: { start: { x: 0, y: 5 }, end: { x: 6, y: 5 } }, depth: 7, depthEnd: 2 },
      { ...base, line: { start: { x: 6, y: 5 }, end: { x: 10, y: 5 } }, depth: 2 },
    ];
  }

  it('re-lerps depth/depthEnd onto each partial split at the split point', () => {
    const classifier = new HiddenLineClassifier({ resolution: 256, samplesPerLine: 100 });
    classifier.buildDepthBuffer([occluderMesh()], { axis: 'z', position: 0, flipped: false }, 10);

    const [l1] = reviewerLines();
    const applied = classifier.applyVisibility([l1]);
    expect(applied).toHaveLength(2);

    const [hiddenHalf, visibleHalf] = applied;
    expect(hiddenHalf.visibility).toBe('hidden');
    expect(visibleHalf.visibility).toBe('visible');
    expect(visibleHalf.line.start.x).toBeCloseTo(2.37, 6);

    // Each split segment's endpoint depths must describe ITS OWN endpoints:
    // the shared split point carries the same lerped depth on both sides.
    expect(hiddenHalf.depth).toBe(7);
    expect(hiddenHalf.depthEnd).toBeCloseTo(5.025, 9);
    expect(visibleHalf.depth).toBeCloseTo(5.025, 9);
    expect(visibleHalf.depthEnd).toBeCloseTo(2, 9);
  });

  it('keeps merged depths honest: merging a split with a neighbour cannot resurrect the pre-split depth', () => {
    const classifier = new HiddenLineClassifier({ resolution: 256, samplesPerLine: 100 });
    classifier.buildDepthBuffer([occluderMesh()], { axis: 'z', position: 0, flipped: false }, 10);

    const applied = classifier.applyVisibility(reviewerLines());
    const merged = mergeDrawingLines(applied);

    const visible = merged.filter((l) => l.visibility === 'visible');
    expect(visible).toHaveLength(1);
    expect(visible[0].line.start.x).toBeCloseTo(2.37, 6);
    expect(visible[0].line.end.x).toBeCloseTo(10, 9);
    // The depth at the merged start must describe that point (about 5, the
    // occluder's own depth there), never L1's original start depth 7.
    expect(visible[0].depth).toBeCloseTo(5.025, 6);
    expect(visible[0].depthEnd).toBeCloseTo(2, 9);
  });
});

describe('HiddenLineClassifier endpoint sampling and raster-bounds edges (PR #2644 review)', () => {
  const cardinalCut = { axis: 'z' as const, position: 0, flipped: false };

  it('treats depthEnd: 0 (an endpoint exactly ON the cut plane) as a real value, not as absent', () => {
    // depth 7 -> depthEnd 0 over the depth-5 occluder crosses at t = 2/7:
    // the far half is hidden, the near half visible. The valid-but-falsy
    // defect class (`depthEnd || depth`) would read the line as constant
    // depth 7 and classify it fully hidden.
    const classifier = new HiddenLineClassifier({ resolution: 64 });
    classifier.buildDepthBuffer([occluderMesh()], cardinalCut, 10);

    const line: DrawingLine = {
      line: { start: { x: 2, y: 5 }, end: { x: 8, y: 5 } },
      category: 'projection',
      visibility: 'visible',
      entityId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
      depth: 7,
      depthEnd: 0,
    };

    const [result] = classifier.classifyLines([line]);
    expect(result.overallVisibility).toBe('partial');
    expect(result.segments.some((s) => s.visible)).toBe(true);
    expect(result.segments.some((s) => !s.visible)).toBe(true);
  });

  it('depth-tests samples exactly ON the raster bounds instead of skipping them as out-of-raster', () => {
    // Explicit bounds [0,10]^2 sit strictly INSIDE a larger occluder
    // (so the border pixels' centers rasterize real depths), and every
    // sample of a line running along the x = 0 or x = 10 bounds edge sits
    // exactly ON the bounds. The out-of-raster early return must stay
    // EXCLUSIVE (< / >): inclusive comparisons would skip the depth test on
    // the whole edge and leak these fully occluded lines visible.
    const z = -5;
    const bigOccluder: MeshData = {
      expressId: 1,
      positions: new Float32Array([
        -2, -2, z,
        12, -2, z,
        12, 12, z,
        -2, 12, z,
      ]),
      normals: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      color: [1, 1, 1, 1],
    };
    const classifier = new HiddenLineClassifier({ resolution: 64 });
    const bounds = { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } };
    classifier.buildDepthBuffer([bigOccluder], cardinalCut, 10, bounds);

    const edgeLine = (x: number): DrawingLine => ({
      line: { start: { x, y: 1 }, end: { x, y: 9 } },
      category: 'projection',
      visibility: 'visible',
      entityId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
      depth: 7,
    });

    const [onMinEdge, onMaxEdge] = classifier.classifyLines([edgeLine(0), edgeLine(10)]);
    expect(onMinEdge.overallVisibility).toBe('hidden');
    expect(onMaxEdge.overallVisibility).toBe('hidden');
  });

  it('samples the final endpoint exactly, so a t=1 lerp overshoot cannot contradict the segments', () => {
    // Sign-straddling coordinates make the t = 1 lerp overshoot the exact
    // endpoint by one ulp (-0.3 + (0.1 - -0.3) = 0.10000000000000003), which
    // lands outside a raster whose bounds end exactly at 0.1. Before the fix
    // that final sample read "visible", labelling this fully occluded line
    // 'partial' while its emitted segments were one hidden run. The occluder
    // extends past the bounds so the border pixels rasterize real depths.
    const z = -5;
    const occluder: MeshData = {
      expressId: 1,
      positions: new Float32Array([
        -0.4, -0.4, z,
        0.2, -0.4, z,
        0.2, 0.2, z,
        -0.4, 0.2, z,
      ]),
      normals: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      color: [1, 1, 1, 1],
    };
    const classifier = new HiddenLineClassifier({ resolution: 64 });
    const bounds = { min: { x: -0.3, y: -0.3 }, max: { x: 0.1, y: 0.1 } };
    classifier.buildDepthBuffer([occluder], cardinalCut, 10, bounds);

    const line: DrawingLine = {
      line: { start: { x: -0.3, y: 0 }, end: { x: 0.1, y: 0 } },
      category: 'projection',
      visibility: 'visible',
      entityId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
      depth: 7,
    };

    const [result] = classifier.classifyLines([line]);
    expect(result.overallVisibility).toBe('hidden');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].visible).toBe(false);
  });

  it('opens a transition when visibility genuinely flips at the final sample', () => {
    // A small occluder covers only the line's very end: with 10 samples over
    // [0, 10], every sample except the last (the exact endpoint x = 10) lies
    // outside the raster and reads visible. The old code refused to open a
    // transition at the final sample, emitting one uniform "visible" run
    // while counting the line 'partial' - segments and overallVisibility
    // contradicted each other.
    const z = -5;
    const endOccluder: MeshData = {
      expressId: 1,
      positions: new Float32Array([
        9.3, -1, z,
        10.5, -1, z,
        10.5, 1, z,
        9.3, 1, z,
      ]),
      normals: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      color: [1, 1, 1, 1],
    };
    const classifier = new HiddenLineClassifier({ resolution: 64 });
    classifier.buildDepthBuffer([endOccluder], cardinalCut, 10);

    const line: DrawingLine = {
      line: { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      category: 'projection',
      visibility: 'visible',
      entityId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
      depth: 7,
    };

    const [result] = classifier.classifyLines([line]);
    expect(result.overallVisibility).toBe('partial');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].visible).toBe(true);
    expect(result.segments[1].visible).toBe(false);
    expect(result.segments[1].start.x).toBeCloseTo(9.5, 9);
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
