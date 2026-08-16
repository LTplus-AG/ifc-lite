/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end arithmetic of the to-scale 3D-view PDF export (#2042).
 *
 * DEFECT CLASS 1 — a page whose numbers are right and whose geometry is not.
 * The showstopper on PR #2119 was a drawing laid out from a frame it was never
 * drawn in: every distance measured correctly while the geometry sat off the
 * page. So the first test does not check the page size alone, it checks that
 * the strokes actually LAND on it — spanning exactly from one margin to the
 * other, on both axes. An offset computed in the wrong frame moves them off
 * that window immediately.
 *
 * DEFECT CLASS 2 — the section cut applied to the wrong half. A symmetric cut
 * hides that completely: keep the left half or the right half of a centred box
 * and the page is the same size either way. The cut here is deliberately
 * OFF-CENTRE (25% of a 4 m span), so the two halves are 1 m and 3 m wide and a
 * flipped-sign bug changes the printed page from 30 mm to 50 mm.
 *
 * DEFECT CLASS 3 — a scale rounded on its way to the filename. v1 has no title
 * block, so the filename is the sheet's only record of what it can be measured
 * at; 1:99.5 filed as "1-100" misreports it by half a percent, which is exactly
 * the error an engineer would never think to look for.
 *
 * Every external edge is injected — the document factory and the download sink
 * — so this runs with no jsPDF, no renderer and no DOM.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import type { PdfPage } from '@ifc-lite/drawing-2d';
import {
  generateViewPdf,
  type ViewCameraSnapshot,
  type ViewPdfDocument,
} from './generate-view-pdf.js';
import type { ViewMeshInput } from './collect-view-meshes.js';
import type { ViewSectionResolveInput } from './view-section-plane.js';

// ── Fixture ────────────────────────────────────────────────────────────────

const BOX = { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 2 } };

/**
 * A closed axis-aligned box: 8 corners, 12 triangles, every face wound
 * OUTWARD.
 *
 * The winding is load-bearing, not tidiness. The generator's only source of
 * line work for an uncut view is `EdgeExtractor.extractSilhouettes`, which
 * compares the two adjacent face normals against the view direction; a box
 * whose faces all happen to point the same way produces no front face, no
 * silhouette, and a completely blank drawing. Reproducing that here would make
 * every assertion below vacuous.
 */
function boxMesh(
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } = BOX,
  expressId = 42,
): MeshData {
  const positions: number[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) positions.push(x, y, z);
    }
  }
  const quads = [
    [0, 1, 3, 2], [4, 6, 7, 5], // x = min / max
    [0, 4, 5, 1], [2, 3, 7, 6], // y = min / max
    [0, 2, 6, 4], [1, 5, 7, 3], // z = min / max
  ];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  return {
    expressId,
    ifcType: 'IfcWall',
    modelIndex: 0,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    indices: new Uint32Array(indices),
    color: [1, 1, 1, 1],
  };
}

/** Every class toggle on: this file is about geometry, not visibility. */
const ALL_TYPES_VISIBLE = {
  spaces: true,
  spatialZones: true,
  openings: true,
  virtualElements: true,
  site: true,
  ifcAnnotations: true,
};

function view(meshes: MeshData[] = [boxMesh()]): ViewMeshInput {
  return {
    meshes,
    instancedMeshes: [],
    hiddenEntities: null,
    isolatedEntities: null,
    computedIsolatedIds: null,
    typeVisibility: ALL_TYPES_VISIBLE,
    modelVisibility: null,
  };
}

/** Looking down -Z with world +Y up: the drawing's X is world X, its Y is world Y. */
const CAMERA: ViewCameraSnapshot = {
  position: { x: 2, y: 1.5, z: 12 },
  target: { x: 2, y: 1.5, z: 1 },
  up: { x: 0, y: 1, z: 0 },
  projectionMode: 'orthographic',
};

/** A cut at 25% of the 4 m X span, i.e. the plane X = 1. */
function sectionAtQuarterX(flipped: boolean): ViewSectionResolveInput {
  return {
    plane: { axis: 'side', position: 25, flipped },
    sceneBounds: BOX,
    uiRange: null,
  };
}

// ── Recording seams ────────────────────────────────────────────────────────

interface Recorded {
  page: PdfPage | null;
  strokes: { x1: number; y1: number; x2: number; y2: number; width: number; dashed: boolean }[];
  saved: { filename: string; size: number }[];
}

function recorder(): {
  record: Recorded;
  createDocument: (page: PdfPage) => Promise<ViewPdfDocument>;
  download: (blob: Blob, filename: string) => void;
} {
  const record: Recorded = { page: null, strokes: [], saved: [] };
  let width = 0;
  let dashed = false;
  return {
    record,
    createDocument: async (page) => {
      record.page = page;
      return {
        setDrawColor: () => {},
        setLineCap: () => {},
        setLineWidth: (w) => { width = w; },
        setLineDashPattern: (pattern) => { dashed = pattern.length > 0; },
        line: (x1, y1, x2, y2) => { record.strokes.push({ x1, y1, x2, y2, width, dashed }); },
        output: () => new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' }),
      };
    },
    download: (blob, filename) => { record.saved.push({ filename, size: blob.size }); },
  };
}

function strokeExtent(record: Recorded): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of record.strokes) {
    minX = Math.min(minX, s.x1, s.x2);
    maxX = Math.max(maxX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2);
    maxY = Math.max(maxY, s.y1, s.y2);
  }
  return { minX, maxX, minY, maxY };
}

const CLOSE = 1e-6;

describe('generateViewPdf (#2042)', () => {
  it('sizes the page to the drawing at an exact scale and draws inside its margins', async () => {
    const { record, createDocument, download } = recorder();
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100 },
      { createDocument, download },
    );

    // 4 m x 3 m at 1:100 is 40 x 30 mm of drawing, plus 10 mm of margin a side.
    assert.ok(Math.abs(result.page.widthMm - 60) < 1e-4, `width ${result.page.widthMm}`);
    assert.ok(Math.abs(result.page.heightMm - 50) < 1e-4, `height ${result.page.heightMm}`);
    assert.deepEqual(record.page, result.page, 'the document must be created at the reported size');

    // The showstopper guard: the ink is ON the page, filling exactly the
    // margin-to-margin window. A layout derived from a frame the points were
    // not drawn in slides this off immediately.
    assert.ok(record.strokes.length > 0, 'a closed box must produce line work');
    const extent = strokeExtent(record);
    assert.ok(Math.abs(extent.minX - 10) < 1e-3, `left edge at ${extent.minX}, expected 10`);
    assert.ok(Math.abs(extent.maxX - 50) < 1e-3, `right edge at ${extent.maxX}, expected 50`);
    assert.ok(Math.abs(extent.minY - 10) < 1e-3, `top edge at ${extent.minY}, expected 10`);
    assert.ok(Math.abs(extent.maxY - 40) < 1e-3, `bottom edge at ${extent.maxY}, expected 40`);
  });

  it('drops the dashed hidden edges when the user turns them off', async () => {
    // The dialog exposes this as "Show hidden edges as dashed lines". A closed
    // box always has occluded far-side edges, so the default run must produce
    // dashed strokes for this test to mean anything - asserting "zero dashed
    // when off" alone would pass just as well against a pipeline that never
    // classified anything hidden in the first place.
    // A convex box on its own has NO occluded edges - its silhouette is its
    // outline and all of it is visible - so the fixture needs a real occluder:
    // a small box parked behind the big one (smaller z is further from the
    // camera) and inside its X/Y footprint, so the big box hides it entirely.
    const HIDDEN_BOX = { min: { x: 1, y: 1, z: -3 }, max: { x: 2, y: 2, z: -2 } };
    const occluded = () => view([boxMesh(), boxMesh(HIDDEN_BOX, 43)]);

    const withHidden = recorder();
    await generateViewPdf(
      { view: occluded(), camera: CAMERA, section: null, scaleFactor: 100, includeHiddenLines: true },
      { createDocument: withHidden.createDocument, download: withHidden.download },
    );
    const dashedCount = withHidden.record.strokes.filter((s) => s.dashed).length;
    assert.ok(dashedCount > 0, 'a closed box must have occluded edges to hide');

    const withoutHidden = recorder();
    await generateViewPdf(
      { view: occluded(), camera: CAMERA, section: null, scaleFactor: 100, includeHiddenLines: false },
      { createDocument: withoutHidden.createDocument, download: withoutHidden.download },
    );
    assert.equal(
      withoutHidden.record.strokes.filter((s) => s.dashed).length,
      0,
      'turning hidden edges off must leave no dashed strokes',
    );

    // The defect this pins: "off" must mean the occluded edges are OMITTED,
    // not merely left unclassified and printed as solid lines. The hidden box
    // spans world x 1..2, y 1..2, which is page x 20..30, y 20..30 - strictly
    // inside the outer box's outline, so any stroke landing in that window is
    // the phantom. Counting strokes alone cannot see this: both runs emit 8.
    const phantom = withoutHidden.record.strokes.filter(
      (s) =>
        Math.min(s.x1, s.x2) > 12 && Math.max(s.x1, s.x2) < 48 &&
        Math.min(s.y1, s.y2) > 12 && Math.max(s.y1, s.y2) < 38,
    );
    assert.equal(
      phantom.length,
      0,
      'an edge hidden behind the box must not print at all when hidden edges are off',
    );
    assert.equal(
      withoutHidden.record.strokes.length,
      withHidden.record.strokes.length - dashedCount,
      'exactly the hidden strokes must be dropped, and nothing else',
    );
  });

  it('puts a feature at world +X/+Y in the TOP-RIGHT of the page, not its mirror', async () => {
    // The page-size assertions above cannot see a mirror: a box's drawing
    // bounds are symmetric about the basis origin, so negating X moves nothing.
    // This fixture breaks that symmetry with a 0.5 m marker parked in the
    // model's +X/+Y corner, and asserts WHERE it prints.
    const marker = { min: { x: 3.5, y: 3, z: 0 }, max: { x: 4, y: 3.5, z: 2 } };
    const { record, createDocument, download } = recorder();
    const result = await generateViewPdf(
      {
        view: view([boxMesh(), boxMesh(marker, 43)]),
        camera: CAMERA,
        section: null,
        scaleFactor: 100,
      },
      { createDocument, download },
    );
    // Union extent is 4 m x 3.5 m: page 60 x 55 mm.
    assert.ok(Math.abs(result.page.widthMm - 60) < 1e-4, `width ${result.page.widthMm}`);
    assert.ok(Math.abs(result.page.heightMm - 55) < 1e-4, `height ${result.page.heightMm}`);

    // Everything above the big box's top edge (page y = 15 mm) belongs to the
    // marker alone. Paper Y grows downward, so "above" is a SMALLER y.
    const markerStrokes = record.strokes.filter((s) => Math.max(s.y1, s.y2) < 14.9);
    assert.ok(markerStrokes.length > 0, 'the marker must print');
    for (const s of markerStrokes) {
      assert.ok(
        Math.min(s.x1, s.x2) >= 44,
        `a marker stroke printed at x=${Math.min(s.x1, s.x2)}; mirrored output would put it near 10-15`,
      );
      assert.ok(
        Math.max(s.y1, s.y2) < result.page.heightMm / 2,
        'the marker must print in the top half; a missing paper Y flip would sink it',
      );
    }
  });

  it('halving the scale factor doubles every printed distance', async () => {
    const a = recorder();
    const b = recorder();
    const at100 = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100 },
      { createDocument: a.createDocument, download: a.download },
    );
    const at50 = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 50 },
      { createDocument: b.createDocument, download: b.download },
    );
    // The drawn area doubles; the fixed 10 mm margin does not.
    assert.ok(Math.abs((at50.page.widthMm - 20) - 2 * (at100.page.widthMm - 20)) < 1e-4);
    assert.ok(Math.abs((at50.page.heightMm - 20) - 2 * (at100.page.heightMm - 20)) < 1e-4);
  });

  it('keeps the same half of an off-centre cut that the viewport keeps', async () => {
    const near = recorder();
    const far = recorder();
    const unflipped = await generateViewPdf(
      { view: view(), camera: CAMERA, section: sectionAtQuarterX(false), scaleFactor: 100 },
      { createDocument: near.createDocument, download: near.download },
    );
    const flipped = await generateViewPdf(
      { view: view(), camera: CAMERA, section: sectionAtQuarterX(true), scaleFactor: 100 },
      { createDocument: far.createDocument, download: far.download },
    );

    // Unflipped keeps x <= 1: a 1 m sliver, 10 mm of drawing plus 20 mm margin.
    assert.ok(Math.abs(unflipped.page.widthMm - 30) < 1e-3, `unflipped width ${unflipped.page.widthMm}`);
    // Flipped keeps x >= 1: the remaining 3 m, 30 mm plus 20 mm margin.
    assert.ok(Math.abs(flipped.page.widthMm - 50) < 1e-3, `flipped width ${flipped.page.widthMm}`);
    // Both stay 3 m tall — the cut is along X only, so a height change here
    // would mean the clip took a bite out of the wrong axis.
    assert.ok(Math.abs(unflipped.page.heightMm - 50) < 1e-3);
    assert.ok(Math.abs(flipped.page.heightMm - 50) < 1e-3);
  });

  it('draws the cut rim as heavy cut lines, ON the cut plane', async () => {
    const { record, createDocument, download } = recorder();
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: sectionAtQuarterX(false), scaleFactor: 100 },
      { createDocument, download },
    );
    const heavy = record.strokes.filter((s) => Math.abs(s.width - 0.5) < CLOSE);
    assert.ok(heavy.length > 0, 'the section rim must print at the cut line weight');

    // Weight alone is NOT the rim's signature: the generator's own cut
    // polygons carry category `cut` too, so "some stroke is 0.5 mm" would
    // still pass with the rim dropped. What is unique to the rim is WHERE it
    // lands. The camera looks down -Z and the cut plane is X = 1, so the
    // cross-section face collapses to a single vertical line at the kept
    // half's outer edge, spanning the box's full 3 m height.
    for (const s of heavy) {
      assert.ok(Math.abs(s.x1 - s.x2) < 1e-3, `a rim stroke must be vertical, got ${s.x1}..${s.x2}`);
    }
    const xs = heavy.flatMap((s) => [s.x1, s.x2]);
    const spread = Math.max(...xs) - Math.min(...xs);
    assert.ok(spread < 1e-3, `every rim stroke must sit on the one cut plane, spread ${spread}`);

    // The cut is at the edge of the kept half, i.e. one of the two margins.
    const rimX = xs[0];
    const atMargin =
      Math.abs(rimX - 10) < 1e-3 || Math.abs(rimX - (result.page.widthMm - 10)) < 1e-3;
    assert.ok(atMargin, `the rim must lie on the cut plane at a page edge, got ${rimX}`);

    // Full height of the box: 3 m at 1:100 is 30 mm. A partial rim (a missed
    // cut triangle) shortens this.
    const ys = heavy.flatMap((s) => [s.y1, s.y2]);
    assert.ok(
      Math.abs((Math.max(...ys) - Math.min(...ys)) - 30) < 1e-3,
      `the rim must span the full 3 m section height, got ${Math.max(...ys) - Math.min(...ys)}`,
    );
  });

  it('files the sheet under the EXACT scale, never a rounded one', async () => {
    const { record, createDocument, download } = recorder();
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 99.5 },
      { createDocument, download },
    );
    assert.equal(result.filename, '3d-view-1-99.5.pdf');
    assert.deepEqual(record.saved.map((s) => s.filename), ['3d-view-1-99.5.pdf']);
    assert.ok(record.saved[0].size > 0, 'the saved blob must carry bytes');
  });

  it('rejects rather than writing a blank sheet when nothing is visible', async () => {
    const { createDocument, download } = recorder();
    await assert.rejects(
      generateViewPdf(
        { view: view([]), camera: CAMERA, section: null, scaleFactor: 100 },
        { createDocument, download },
      ),
      /no geometry is visible/,
    );
  });

  it('rejects when the section cut removes everything, rather than writing an empty sheet', async () => {
    const { record, createDocument, download } = recorder();
    await assert.rejects(
      generateViewPdf(
        {
          view: view(),
          camera: CAMERA,
          // The scene box runs to x = 100 while the model stops at x = 4, so a
          // flipped cut at 100% keeps only x >= 100: nothing at all.
          section: {
            plane: { axis: 'side', position: 100, flipped: true },
            sceneBounds: { min: BOX.min, max: { x: 100, y: 3, z: 2 } },
            uiRange: null,
          },
          scaleFactor: 100,
        },
        { createDocument, download },
      ),
      /removes all visible geometry/,
    );
    assert.equal(record.page, null, 'no document may be created for an empty cut');
    assert.deepEqual(record.saved, [], 'nothing may be saved for an empty cut');
  });

  it('surfaces a failing document factory as a rejection, not an unhandled one', async () => {
    await assert.rejects(
      generateViewPdf(
        { view: view(), camera: CAMERA, section: null, scaleFactor: 100 },
        {
          createDocument: () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
          download: () => {},
        },
      ),
      /dynamically imported module/,
    );
  });
});
