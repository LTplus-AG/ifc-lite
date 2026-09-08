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
import {
  buildCameraSectionPlane,
  computePdfScaleLayout,
  projectPointForPlane,
  worldBoundsOfMeshes,
  worldPointToPdfMm,
  type Bounds2D,
  type ColorRaster,
  type PdfPage,
} from '@ifc-lite/drawing-2d';
import {
  generateViewPdf,
  type ViewCameraSnapshot,
  type ViewPdfDeps,
  type ViewPdfDocument,
} from './generate-view-pdf.js';
import type { ViewMeshInput } from './collect-view-meshes.js';
import type { ViewSectionResolveInput } from './view-section-plane.js';
import type { ShadingRasterRequest, ShadingRasterResult } from './view-pdf-shading.js';

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

/** The marker bytes the stub encoder hands back, so the image can be identified. */
const PNG_MARKER = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

interface RecordedStroke {
  x1: number; y1: number; x2: number; y2: number;
  width: number; dashed: boolean;
  /** Position in the document's single call order, shared with `images`. */
  order: number;
}

interface RecordedImage {
  bytes: Uint8Array;
  xMm: number; yMm: number; widthMm: number; heightMm: number;
  order: number;
}

/** A scale-bar division. `style` is jsPDF's: 'FD' fills and strokes, 'S' strokes. */
interface RecordedRect {
  xMm: number; yMm: number; widthMm: number; heightMm: number;
  style: 'S' | 'FD';
  order: number;
}

interface RecordedText {
  text: string;
  xMm: number; yMm: number;
  align: 'left' | 'center';
  sizePt: number;
  order: number;
}

interface Recorded {
  page: PdfPage | null;
  strokes: RecordedStroke[];
  images: RecordedImage[];
  rects: RecordedRect[];
  texts: RecordedText[];
  rasterRequests: ShadingRasterRequest[];
  saved: { filename: string; size: number }[];
}

interface Recorder {
  record: Recorded;
  /** Every seam at once — the document, the sink, the rasteriser, the encoder. */
  deps: ViewPdfDeps;
}

/**
 * `raster: 'real'` leaves the rasteriser seam UNINJECTED, so the export runs
 * the shipped `buildShadingRaster` and its real pixel-fit arithmetic. That is
 * the only way to exercise what the fit does with an impossible request: a stub
 * builder accepts a zero-width drawing happily, so a test that injected one
 * could not fail if the guard against it were deleted.
 */
function recorder(options: { raster?: 'contract' | 'none' | 'real' } = {}): Recorder {
  const record: Recorded = {
    page: null, strokes: [], images: [], rects: [], texts: [], rasterRequests: [], saved: [],
  };
  let width = 0;
  let dashed = false;
  let sizePt = 0;
  let order = 0;
  const rasterSeam: Pick<ViewPdfDeps, 'buildRaster' | 'encodePng'> =
    options.raster === 'real'
      ? {}
      : {
          buildRaster: async (request) => {
            record.rasterRequests.push(request);
            return options.raster === 'none' ? EMPTY_RASTER : contractRaster(request);
          },
          encodePng: async () => PNG_MARKER,
        };
  return {
    record,
    deps: {
      ...rasterSeam,
      createDocument: async (page) => {
        record.page = page;
        const doc: ViewPdfDocument = {
          setDrawColor: () => {},
          setFillColor: () => {},
          setTextColor: () => {},
          setLineCap: () => {},
          setLineWidth: (w) => { width = w; },
          setLineDashPattern: (pattern) => { dashed = pattern.length > 0; },
          setFontSize: (size) => { sizePt = size; },
          line: (x1, y1, x2, y2) => {
            record.strokes.push({ x1, y1, x2, y2, width, dashed, order: order++ });
          },
          rect: (xMm, yMm, widthMm, heightMm, style) => {
            record.rects.push({ xMm, yMm, widthMm, heightMm, style, order: order++ });
          },
          text: (text, xMm, yMm, textOptions) => {
            record.texts.push({ text, xMm, yMm, align: textOptions.align, sizePt, order: order++ });
          },
          addImage: (bytes, xMm, yMm, widthMm, heightMm) => {
            record.images.push({ bytes, xMm, yMm, widthMm, heightMm, order: order++ });
          },
          output: () => new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' }),
        };
        return doc;
      },
      download: (blob, filename) => { record.saved.push({ filename, size: blob.size }); },
    },
  };
}

const EMPTY_RASTER: ShadingRasterResult = {
  raster: null,
  fit: { widthPx: 0, heightPx: 0, effectiveDpi: 150, capped: false },
};

/**
 * A stand-in for the real rasteriser that honours the one property the
 * placement depends on: `bounds` is the projected extent of the meshes with NO
 * margin, in the same 2D frame the strokes are drawn in. Everything else about
 * a raster (its colours, its shading) is the rasteriser's own business and is
 * tested where it lives.
 */
function contractRaster(request: ShadingRasterRequest): ShadingRasterResult {
  const bounds = projectedExtent(request);
  const widthPx = Math.max(1, Math.ceil((request.drawingWidthMm * request.dpi) / 25.4));
  const heightPx = Math.max(1, Math.ceil((request.drawingHeightMm * request.dpi) / 25.4));
  if (!bounds) return EMPTY_RASTER;
  return {
    raster: { pixels: new Uint8ClampedArray(4), width: widthPx, height: heightPx, bounds },
    fit: { widthPx, heightPx, effectiveDpi: request.dpi, capped: false },
  };
}

function projectedExtent(request: ShadingRasterRequest): Bounds2D | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const mesh of request.meshes) {
    const [ox, oy, oz] = mesh.origin ?? [0, 0, 0];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const p = projectPointForPlane(
        { x: mesh.positions[i] + ox, y: mesh.positions[i + 1] + oy, z: mesh.positions[i + 2] + oz },
        request.plane,
      );
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
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

/**
 * Height the scale band adds to every sheet, mm.
 *
 * Pinned by hand rather than imported: it is a deliberate layout value (a 2.5mm
 * bar, its tick labels and the ratio text, with their gaps), and reading it out
 * of the code under test would make every page-size assertion below agree with
 * whatever the code currently does. It does NOT vary with scale or page size,
 * which is itself asserted by the 1:100-vs-1:50 test.
 */
const STAMP_BAND_MM = 17;

describe('generateViewPdf (#2042)', () => {
  it('sizes the page to the drawing at an exact scale and draws inside its margins', async () => {
    const { record, deps } = recorder();
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100 },
      deps,
    );

    // 4 m x 3 m at 1:100 is 40 x 30 mm of drawing, plus 10 mm of margin a side,
    // plus the scale band below the drawing (on by default).
    assert.ok(Math.abs(result.page.widthMm - 60) < 1e-4, `width ${result.page.widthMm}`);
    assert.ok(
      Math.abs(result.page.heightMm - (50 + STAMP_BAND_MM)) < 1e-4,
      `height ${result.page.heightMm}`,
    );
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
    // `renderMode: 'lines'` throughout: the toggle is a line-work-mode choice,
    // and the shaded mode overrides it deliberately (pinned separately below).
    const HIDDEN_BOX = { min: { x: 1, y: 1, z: -3 }, max: { x: 2, y: 2, z: -2 } };
    const occluded = () => view([boxMesh(), boxMesh(HIDDEN_BOX, 43)]);

    const withHidden = recorder();
    await generateViewPdf(
      {
        view: occluded(), camera: CAMERA, section: null, scaleFactor: 100,
        renderMode: 'lines', includeHiddenLines: true,
      },
      withHidden.deps,
    );
    const dashedCount = withHidden.record.strokes.filter((s) => s.dashed).length;
    assert.ok(dashedCount > 0, 'a closed box must have occluded edges to hide');

    const withoutHidden = recorder();
    await generateViewPdf(
      {
        view: occluded(), camera: CAMERA, section: null, scaleFactor: 100,
        renderMode: 'lines', includeHiddenLines: false,
      },
      withoutHidden.deps,
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
    const { record, deps } = recorder();
    const result = await generateViewPdf(
      {
        view: view([boxMesh(), boxMesh(marker, 43)]),
        camera: CAMERA,
        section: null,
        scaleFactor: 100,
      },
      deps,
    );
    // Union extent is 4 m x 3.5 m: page 60 x 55 mm, plus the scale band.
    assert.ok(Math.abs(result.page.widthMm - 60) < 1e-4, `width ${result.page.widthMm}`);
    assert.ok(
      Math.abs(result.page.heightMm - (55 + STAMP_BAND_MM)) < 1e-4,
      `height ${result.page.heightMm}`,
    );

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
      a.deps,
    );
    const at50 = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 50 },
      b.deps,
    );
    // The drawn area doubles; the fixed 10 mm margin does not, and neither does
    // the scale band — a band that scaled with the drawing would fail here.
    assert.ok(Math.abs((at50.page.widthMm - 20) - 2 * (at100.page.widthMm - 20)) < 1e-4);
    const drawnHeight = (page: PdfPage) => page.heightMm - 20 - STAMP_BAND_MM;
    assert.ok(
      Math.abs(drawnHeight(at50.page) - 2 * drawnHeight(at100.page)) < 1e-4,
      `${drawnHeight(at50.page)} vs 2 x ${drawnHeight(at100.page)}`,
    );
  });

  it('keeps the same half of an off-centre cut that the viewport keeps', async () => {
    // The scale band is off here on purpose: it is furniture whose width floor
    // would widen the page of the 1 m sliver, and this test is about the CUT.
    // The band's own page arithmetic is pinned in its own tests below.
    const near = recorder();
    const far = recorder();
    const unflipped = await generateViewPdf(
      {
        view: view(), camera: CAMERA, section: sectionAtQuarterX(false),
        scaleFactor: 100, includeScaleStamp: false,
      },
      near.deps,
    );
    const flipped = await generateViewPdf(
      {
        view: view(), camera: CAMERA, section: sectionAtQuarterX(true),
        scaleFactor: 100, includeScaleStamp: false,
      },
      far.deps,
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
    // Scale band off: the rim is checked against the page EDGE, and the band's
    // minimum bar width would widen this 10 mm-wide sliver of a page.
    const { record, deps } = recorder();
    const result = await generateViewPdf(
      {
        view: view(), camera: CAMERA, section: sectionAtQuarterX(false),
        scaleFactor: 100, includeScaleStamp: false,
      },
      deps,
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
    const { record, deps } = recorder();
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 99.5 },
      deps,
    );
    assert.equal(result.filename, '3d-view-1-99.5.pdf');
    assert.deepEqual(record.saved.map((s) => s.filename), ['3d-view-1-99.5.pdf']);
    assert.ok(record.saved[0].size > 0, 'the saved blob must carry bytes');
  });

  it('rejects rather than writing a blank sheet when nothing is visible', async () => {
    const { deps } = recorder();
    await assert.rejects(
      generateViewPdf(
        { view: view([]), camera: CAMERA, section: null, scaleFactor: 100 },
        deps,
      ),
      /no geometry is visible/,
    );
  });

  it('rejects when the section cut removes everything, rather than writing an empty sheet', async () => {
    const { record, deps } = recorder();
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
        deps,
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

/**
 * The scale the sheet carries on the paper (#2042 follow-up).
 *
 * DEFECT CLASS 4 — a printed sheet with no record of its own scale. The
 * filename says "1-100" and the paper says nothing, so the print gets measured
 * at an assumed scale, or a photocopy that rescaled the page gets measured at
 * the scale the original was drawn at. A drawn bar answers both; a printed
 * ratio answers only the first, so the sheet carries both.
 *
 * DEFECT CLASS 5 — furniture that moves the drawing. Adding anything to a sheet
 * through a fit-to-page transform (`calculateDrawingTransform` is one line
 * away, in the same package) leaves a page that looks right and measures wrong.
 * So the second test measures a real distance between projected world points
 * with the band on and off, and demands every stroke be identical.
 */
describe('generateViewPdf scale stamp (#2042)', () => {
  /** Bar divisions are the only rectangles this writer emits. */
  const barRects = (record: Recorded) => [...record.rects].sort((a, b) => a.xMm - b.xMm);

  it('prints a to-scale bar and the exact ratio, below the drawing, by default', async () => {
    const { record, deps } = recorder();
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100 },
      deps,
    );

    // The claim, in the units an engineer would check it in: at 1:100 one metre
    // is 10 mm of paper, so a division labelled "1" sits 10.000 mm along the
    // bar and each division rectangle is 10.000 mm wide.
    const rects = barRects(record);
    assert.ok(rects.length >= 2, `a scale bar needs divisions, got ${rects.length}`);
    const barLeft = rects[0].xMm;
    for (const rect of rects) {
      assert.ok(
        Math.abs(rect.widthMm - 10) < 1e-9,
        `a 1 m division must print 10 mm wide at 1:100, got ${rect.widthMm}`,
      );
    }
    const oneMetre = record.texts.find((t) => t.text === '1');
    assert.ok(oneMetre, `the bar must label its metres, got ${record.texts.map((t) => t.text)}`);
    assert.ok(
      Math.abs(oneMetre.xMm - barLeft - 10) < 1e-9,
      `the "1" label sits ${oneMetre.xMm - barLeft} mm along the bar, expected 10`,
    );
    // Alternating fill: the pattern that still reads after a copier washes the
    // tick labels out.
    assert.equal(rects[0].style, 'FD');
    assert.equal(rects[1].style, 'S');

    // The ratio, verbatim from the shared formatter.
    assert.ok(
      record.texts.some((t) => t.text === 'Scale 1:100'),
      `the sheet must state its scale, got ${record.texts.map((t) => t.text)}`,
    );

    // On the paper, and clear of the ink: the drawing ends 10 mm above the
    // pre-band page bottom, and the band lives between there and the new one.
    const ink = strokeExtent(record);
    for (const rect of rects) {
      assert.ok(rect.yMm > ink.maxY, `a bar division overlaps the drawing at y=${rect.yMm}`);
      assert.ok(rect.yMm + rect.heightMm < result.page.heightMm, 'the bar must be on the page');
      assert.ok(rect.xMm >= 10 - 1e-9 && rect.xMm + rect.widthMm <= result.page.widthMm - 10 + 1e-9);
    }
    for (const text of record.texts) {
      assert.ok(text.yMm > ink.maxY, `a stamp label overlaps the drawing at y=${text.yMm}`);
      assert.ok(text.yMm < result.page.heightMm, 'a stamp label must be on the page');
      assert.ok(text.sizePt > 0, 'text must be sized before it is written');
    }
  });

  it('measures identically with the scale band and without it', async () => {
    const withStamp = recorder();
    const without = recorder();
    const stamped = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100 },
      withStamp.deps,
    );
    const plain = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100, includeScaleStamp: false },
      without.deps,
    );

    // The distance between two projected world points - the box's own opposite
    // corners, 4 m and 3 m apart - must not move by an ulp. This is what a
    // fit-to-page furniture layout would break, while every other number on the
    // sheet still looked plausible.
    const a = strokeExtent(withStamp.record);
    const b = strokeExtent(without.record);
    assert.equal(a.maxX - a.minX, b.maxX - b.minX, 'the drawn width must not change');
    assert.equal(a.maxY - a.minY, b.maxY - b.minY, 'the drawn height must not change');
    assert.ok(Math.abs((a.maxX - a.minX) - 40) < 1e-9, `4 m at 1:100 is 40 mm, got ${a.maxX - a.minX}`);
    assert.ok(Math.abs((a.maxY - a.minY) - 30) < 1e-9, `3 m at 1:100 is 30 mm, got ${a.maxY - a.minY}`);
    // Not merely the same size: the same strokes at the same millimetres.
    assert.deepEqual(
      withStamp.record.strokes.map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 })),
      without.record.strokes.map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 })),
    );
    // The image the strokes sit on moves no more than they do.
    assert.deepEqual(
      withStamp.record.images.map((i) => [i.xMm, i.yMm, i.widthMm, i.heightMm]),
      without.record.images.map((i) => [i.xMm, i.yMm, i.widthMm, i.heightMm]),
    );

    // All the band did was make the paper taller.
    assert.equal(stamped.page.widthMm, plain.page.widthMm);
    assert.ok(
      Math.abs(stamped.page.heightMm - plain.page.heightMm - STAMP_BAND_MM) < 1e-9,
      `band added ${stamped.page.heightMm - plain.page.heightMm} mm`,
    );
  });

  it('leaves the sheet bare when the caller turns the stamp off', async () => {
    const { record, deps } = recorder();
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100, includeScaleStamp: false },
      deps,
    );
    assert.deepEqual(record.rects, [], 'no bar may be drawn when it was turned off');
    assert.deepEqual(record.texts, [], 'and no text either');
    assert.ok(Math.abs(result.page.heightMm - 50) < 1e-4, `height ${result.page.heightMm}`);
    assert.ok(record.strokes.length > 0, 'the drawing itself still prints');
  });

  it('prints the exact ratio on the sheet, never a rounded one', async () => {
    // The filename already carries 1:99.5 (pinned above). The PAPER is what an
    // engineer measures, so it must not round to a materially different scale
    // either - and the bar must stay to scale at that odd factor.
    const { record, deps } = recorder();
    await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 99.5 },
      deps,
    );
    assert.ok(
      record.texts.some((t) => t.text === 'Scale 1:99.5'),
      `expected "Scale 1:99.5", got ${record.texts.map((t) => t.text)}`,
    );
    assert.equal(record.texts.filter((t) => t.text.includes('1:100')).length, 0);
    for (const rect of barRects(record)) {
      // 1 m at 1:99.5 is 1000/99.5 = 10.0502... mm, not 10.
      assert.ok(
        Math.abs(rect.widthMm - 1000 / 99.5) < 1e-9,
        `a 1 m division at 1:99.5 must be ${1000 / 99.5} mm, got ${rect.widthMm}`,
      );
    }
  });

  it('hedges an "as displayed" factor it had to round, and draws it unrounded', async () => {
    // The dialog's DEFAULT is "as displayed", which delivers whatever factor
    // the viewport happens to sit at. Two decimals is all the filename can
    // carry, and the sheet must quote the same number — so it says the ratio is
    // the nearest hundredth rather than stating a scale nothing was drawn at.
    const factor = 87.3456;
    const { record, deps } = recorder();
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: factor },
      deps,
    );

    assert.ok(
      record.texts.some((t) => t.text === 'Scale about 1:87.35'),
      `expected "Scale about 1:87.35", got ${record.texts.map((t) => t.text)}`,
    );
    assert.equal(
      record.texts.filter((t) => t.text === 'Scale 1:87.35').length,
      0,
      'an unhedged ratio would state a scale the drawing was not drawn at',
    );
    // Sheet and filename quote the SAME number, which is the mismatch this
    // export used to carry: the filename rounded while the paper said nothing.
    assert.equal(result.filename, '3d-view-1-87.35.pdf');

    // And the bar is laid out at the UNROUNDED factor. Every tick label is its
    // own metre value, so each must sit `metres * 1000/87.3456` mm along the
    // bar — 5.8e-4 mm per 10 mm away from where the printed 87.35 would put it,
    // which the second assertion pins so a bar built from the label fails here.
    const rects = barRects(record);
    const barLeft = rects[0].xMm;
    const ticks = record.texts.filter((t) => /^\d+(\.\d+)?( m)?$/.test(t.text));
    assert.ok(ticks.length >= 2, `the bar must label its metres, got ${ticks.length}`);
    for (const tick of ticks) {
      const metres = Number.parseFloat(tick.text);
      assert.ok(
        Math.abs(tick.xMm - barLeft - metres * (1000 / factor)) < 1e-9,
        `the "${tick.text}" tick sits ${tick.xMm - barLeft} mm along the bar, ` +
          `expected ${metres * (1000 / factor)}`,
      );
      if (metres > 0) {
        assert.ok(
          Math.abs(tick.xMm - barLeft - metres * (1000 / 87.35)) > 1e-6,
          `the "${tick.text}" tick is where the PRINTED rounding would put it, not the drawn scale`,
        );
      }
    }
  });
});

/**
 * An edge-on view: a real thing to ask for, and until #2042's follow-up it
 * rejected the entire export.
 *
 * A planar element seen along its own plane projects to a LINE, so the drawing
 * has zero extent on one axis. The shading rasteriser cannot make a pixel grid
 * out of that and says so by throwing — which surfaced as a raw internal string
 * ("Invalid shading raster drawingWidthMm: 0") and lost the user a sheet whose
 * line work was exact and to scale. The optional part of the sheet must never
 * take the mandatory part down with it.
 */
describe('generateViewPdf edge-on view (#2042)', () => {
  /**
   * The section slider dragged to the very start of its travel: the cut lands
   * exactly on the box's own x = 0 face, so all that survives is that face,
   * seen edge-on. It draws (a rim is a rim) and it draws a LINE.
   */
  const sectionAtTheFace: ViewSectionResolveInput = {
    plane: { axis: 'side', position: 0, flipped: false },
    sceneBounds: BOX,
    uiRange: null,
  };

  it('degrades to line work instead of rejecting the sheet', async () => {
    // The REAL rasteriser, uninjected: a stub accepts a zero-width request
    // without complaint, so injecting one here would test nothing.
    const { record, deps } = recorder({ raster: 'real' });
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: sectionAtTheFace, scaleFactor: 100 },
      deps,
    );

    // The drawing really is degenerate on X — that is the input, not an
    // accident. Without this, everything below would pass on an ordinary view.
    const ink = strokeExtent(record);
    assert.ok(record.strokes.length > 0, 'the line work must still be written');
    assert.ok(
      Math.abs(ink.maxX - ink.minX) < 1e-9,
      `an edge-on view draws a line, got ${ink.maxX - ink.minX} mm of width`,
    );
    // Shading was asked for (it is the default mode) and quietly skipped,
    // rather than taking the export down on the way out.
    assert.equal(result.shading, null, 'a zero-width drawing has no raster to place');
    assert.deepEqual(record.images, [], 'and nothing may be placed on the page');
    // The parts that matter still printed, at the scale they claim.
    assert.ok(
      Math.abs((ink.maxY - ink.minY) - 30) < 1e-9,
      `3 m at 1:100 is 30 mm of line work, got ${ink.maxY - ink.minY}`,
    );
    assert.ok(
      record.texts.some((t) => t.text === 'Scale 1:100'),
      `the sheet still states its scale, got ${record.texts.map((t) => t.text)}`,
    );
    assert.equal(record.saved.length, 1, 'and the file is actually delivered');
  });
});

/**
 * The shaded underlay (#2042 follow-up: "these are all colorless non solid.
 * not what we see in 3D").
 *
 * DEFECT CLASS 4 — a sheet that measures right and looks nothing like the
 * view. Shading is therefore the DEFAULT, and the tests here pin the two ways
 * adding an image could break the sheet: painting it over the line work
 * (ordering), and sizing it from anything other than the one scale transform
 * (dimensions).
 */
describe('generateViewPdf shaded mode (#2042)', () => {
  const plainStroke = (s: RecordedStroke) => ({
    x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, width: s.width, dashed: s.dashed,
  });

  it('shades by default, and puts the image UNDER every stroke', async () => {
    const { record, deps } = recorder();
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100 },
      deps,
    );

    assert.equal(record.images.length, 1, 'a sheet carries exactly one shading image');
    assert.deepEqual(
      record.images[0].bytes,
      PNG_MARKER,
      'the placed bytes must be what the encoder produced',
    );
    assert.ok(record.strokes.length > 0, 'the line work must still print on top');
    // A PDF paints in call order, so an image written after a stroke hides it.
    assert.ok(
      record.images[0].order < Math.min(...record.strokes.map((s) => s.order)),
      'the image must be written before the first stroke',
    );
    // 40 x 30 mm of drawing at 150 dpi is ceil(40 * 150 / 25.4) x
    // ceil(30 * 150 / 25.4) pixels, which is what the stub rasteriser returns.
    assert.deepEqual(
      result.shading,
      { widthPx: 237, heightPx: 178, dpi: 150 },
      'the result must report the resolution the sheet actually got',
    );
  });

  it('places the image at the same millimetres the strokes are drawn at', async () => {
    const at100 = recorder();
    const at50 = recorder();
    await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100 },
      at100.deps,
    );
    await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 50 },
      at50.deps,
    );

    // The box is 4 m x 3 m: 40 x 30 mm at 1:100, starting at the 10 mm margin.
    const a = at100.record.images[0];
    assert.ok(Math.abs(a.xMm - 10) < 1e-9, `x ${a.xMm}`);
    assert.ok(Math.abs(a.yMm - 10) < 1e-9, `y ${a.yMm}`);
    assert.ok(Math.abs(a.widthMm - 40) < 1e-9, `width ${a.widthMm}`);
    assert.ok(Math.abs(a.heightMm - 30) < 1e-9, `height ${a.heightMm}`);

    // Halving the scale doubles the image exactly as it doubles the strokes.
    // A rectangle derived from the pixel grid instead would not move at all.
    const b = at50.record.images[0];
    assert.ok(Math.abs(b.widthMm - 80) < 1e-9, `width ${b.widthMm}`);
    assert.ok(Math.abs(b.heightMm - 60) < 1e-9, `height ${b.heightMm}`);
    assert.ok(Math.abs((b.xMm - 10) - 2 * (a.xMm - 10)) < 1e-9);
    assert.ok(Math.abs((b.yMm - 10) - 2 * (a.yMm - 10)) < 1e-9);

    const extentA = strokeExtent(at100.record);
    const extentB = strokeExtent(at50.record);
    assert.ok(Math.abs((extentB.minX - 10) - 2 * (extentA.minX - 10)) < 1e-9);
    assert.ok(Math.abs((extentB.maxX - 10) - 2 * (extentA.maxX - 10)) < 1e-9);
    // The image spans exactly the stroke window, so a frame drift between the
    // two shows up as a corner that no longer coincides.
    assert.ok(Math.abs(a.xMm - extentA.minX) < 1e-6, `image left ${a.xMm} vs ink ${extentA.minX}`);
    assert.ok(Math.abs(a.yMm - extentA.minY) < 1e-6, `image top ${a.yMm} vs ink ${extentA.minY}`);
    assert.ok(Math.abs((a.xMm + a.widthMm) - extentA.maxX) < 1e-6);
    assert.ok(Math.abs((a.yMm + a.heightMm) - extentA.maxY) < 1e-6);
  });

  it('writes no image at all in line work mode', async () => {
    const { record, deps } = recorder();
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100, renderMode: 'lines' },
      deps,
    );
    assert.deepEqual(record.images, [], 'line work mode must not embed an image');
    assert.deepEqual(record.rasterRequests, [], 'and must not pay for a raster it will not use');
    assert.equal(result.shading, null);
    assert.ok(record.strokes.length > 0);
  });

  it('forces hidden edges off while shading, whatever the caller asked', async () => {
    // Dashes over a shaded surface read as real edges ON that surface, so the
    // raster's own occlusion is the only one that may show.
    const HIDDEN_BOX = { min: { x: 1, y: 1, z: -3 }, max: { x: 2, y: 2, z: -2 } };
    const occluded = () => view([boxMesh(), boxMesh(HIDDEN_BOX, 43)]);

    const shaded = recorder();
    await generateViewPdf(
      {
        view: occluded(), camera: CAMERA, section: null, scaleFactor: 100,
        includeHiddenLines: true,
      },
      shaded.deps,
    );
    const linesOff = recorder();
    await generateViewPdf(
      {
        view: occluded(), camera: CAMERA, section: null, scaleFactor: 100,
        renderMode: 'lines', includeHiddenLines: false,
      },
      linesOff.deps,
    );
    const linesOn = recorder();
    await generateViewPdf(
      {
        view: occluded(), camera: CAMERA, section: null, scaleFactor: 100,
        renderMode: 'lines', includeHiddenLines: true,
      },
      linesOn.deps,
    );

    // The fixture genuinely has occluded edges, so "no dashes" is a result and
    // not an accident of a fixture that never had any.
    assert.ok(
      linesOn.record.strokes.length > linesOff.record.strokes.length,
      'the fixture must have hidden edges for this to mean anything',
    );
    assert.deepEqual(
      shaded.record.strokes.map(plainStroke),
      linesOff.record.strokes.map(plainStroke),
      'a shaded sheet must carry exactly the visible line work',
    );
    assert.equal(shaded.record.strokes.filter((s) => s.dashed).length, 0);
  });

  it('rejects when the PNG encoder fails, rather than saving an unshaded sheet', async () => {
    const { record, deps } = recorder();
    await assert.rejects(
      generateViewPdf(
        { view: view(), camera: CAMERA, section: null, scaleFactor: 100 },
        { ...deps, encodePng: () => Promise.reject(new Error('OffscreenCanvas is unavailable')) },
      ),
      /OffscreenCanvas is unavailable/,
    );
    assert.deepEqual(record.saved, [], 'nothing may be downloaded when the shading failed');
  });

  it('still prints the line work when the rasteriser produces nothing', async () => {
    const { record, deps } = recorder({ raster: 'none' });
    const result = await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100 },
      deps,
    );
    assert.equal(result.shading, null, 'the caller must be told the sheet has no shading');
    assert.deepEqual(record.images, []);
    assert.ok(record.strokes.length > 0, 'a shaded export must never lose the line work');
    assert.equal(record.saved.length, 1, 'and it must still be saved');
  });
});

/**
 * The same sheet, built by the REAL rasteriser.
 *
 * Every test above stubs the raster with one that honours the placement
 * contract by construction, which is exactly what a contract stub is for and
 * exactly why it cannot catch the integration defect: a rasteriser whose bounds
 * are not the ones the placement assumes. Bounds grown by a margin (the
 * hidden-line raster grows its own by 1%), a pixel grid mapped centre-to-centre
 * instead of edge-to-edge, or an image built upside down all leave the stub
 * tests green and print a sheet whose shading sits beside its line work.
 *
 * So these run the shipped `buildColorRaster` end to end, with only the
 * document, the sink and the PNG encoder stubbed, and measure the image against
 * the strokes it has to register with.
 */
describe('generateViewPdf shading, real rasteriser (#2042)', () => {
  /** Recorder deps with NO `buildRaster`, so the default (real) one runs. */
  function realRasterDeps(): {
    record: Recorded;
    rasters: ColorRaster[];
    deps: ViewPdfDeps;
  } {
    const { record, deps } = recorder();
    const rasters: ColorRaster[] = [];
    return {
      record,
      rasters,
      deps: {
        createDocument: deps.createDocument,
        download: deps.download,
        encodePng: async (raster) => {
          rasters.push(raster);
          return PNG_MARKER;
        },
      },
    };
  }

  it('places the real raster at exactly boundsWidth * 1000 / scaleFactor mm', async () => {
    const at100 = realRasterDeps();
    const at50 = realRasterDeps();
    await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 100 },
      at100.deps,
    );
    await generateViewPdf(
      { view: view(), camera: CAMERA, section: null, scaleFactor: 50 },
      at50.deps,
    );

    // The box is 4 m x 3 m and the rasteriser's bounds carry no margin, so at
    // 1:100 the image is 4 * 1000/100 = 40 mm wide, exactly, from the 10 mm
    // margin. Any margin the rasteriser added to its bounds shows up here.
    const a = at100.record.images[0];
    assert.equal(at100.record.images.length, 1);
    assert.ok(Math.abs(a.widthMm - 40) < 1e-9, `width ${a.widthMm}`);
    assert.ok(Math.abs(a.heightMm - 30) < 1e-9, `height ${a.heightMm}`);
    assert.ok(Math.abs(a.xMm - 10) < 1e-9, `x ${a.xMm}`);
    assert.ok(Math.abs(a.yMm - 10) < 1e-9, `y ${a.yMm}`);

    // Halving the scale factor doubles the drawn area - image and ink alike.
    const b = at50.record.images[0];
    assert.ok(Math.abs(b.widthMm - 2 * a.widthMm) < 1e-9, `width ${b.widthMm}`);
    assert.ok(Math.abs(b.heightMm - 2 * a.heightMm) < 1e-9, `height ${b.heightMm}`);
    assert.ok(Math.abs((b.xMm - 10) - 2 * (a.xMm - 10)) < 1e-9);
    assert.ok(Math.abs((b.yMm - 10) - 2 * (a.yMm - 10)) < 1e-9);
    for (const s of at50.record.strokes) {
      // Every stroke doubles about the margin too, so the image and the line
      // work cannot have been laid out at two different scales.
      assert.ok(s.x1 >= 10 - 1e-6 && s.x1 <= 90 + 1e-6, `stroke x ${s.x1} off the drawn window`);
    }
    const inkA = strokeExtent(at100.record);
    const inkB = strokeExtent(at50.record);
    assert.ok(Math.abs((inkB.maxX - 10) - 2 * (inkA.maxX - 10)) < 1e-9);
    assert.ok(Math.abs((inkB.maxY - 10) - 2 * (inkA.maxY - 10)) < 1e-9);

    // And the image covers exactly the inked window, on all four sides.
    assert.ok(Math.abs(a.xMm - inkA.minX) < 1e-6, `image left ${a.xMm} vs ink ${inkA.minX}`);
    assert.ok(Math.abs(a.yMm - inkA.minY) < 1e-6, `image top ${a.yMm} vs ink ${inkA.minY}`);
    assert.ok(Math.abs((a.xMm + a.widthMm) - inkA.maxX) < 1e-6);
    assert.ok(Math.abs((a.yMm + a.heightMm) - inkA.maxY) < 1e-6);
  });

  it('registers a world point to the same millimetres through the pixels as through the transform', async () => {
    // Two 1 m boxes on opposite corners of a 4 x 3 m window: the raster is
    // mostly EMPTY, so where its opaque pixels sit is a real measurement and
    // not "the whole rectangle is covered anyway".
    const lowerLeft = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 2 } };
    const upperRight = { min: { x: 3, y: 2, z: 0 }, max: { x: 4, y: 3, z: 2 } };
    const meshes = [boxMesh(lowerLeft, 51), boxMesh(upperRight, 52)];
    const { record, rasters, deps } = realRasterDeps();
    await generateViewPdf(
      { view: view(meshes), camera: CAMERA, section: null, scaleFactor: 100 },
      deps,
    );

    // The drawing frame is the CAMERA basis, whose origin sits at the plane,
    // not at the world origin - so a world point has to be projected before it
    // can be compared with anything on the page. This is the same plane the
    // export built, from the same inputs.
    const worldBounds = worldBoundsOfMeshes(meshes);
    assert.ok(worldBounds, 'the fixture must have world bounds');
    const { plane } = buildCameraSectionPlane(CAMERA, worldBounds);
    const drawingPoint = (x: number, y: number) => projectPointForPlane({ x, y, z: 1 }, plane);

    assert.equal(rasters.length, 1, 'the encoder must have been handed exactly one raster');
    const raster = rasters[0];
    const rect = record.images[0];
    const { min, max } = raster.bounds;
    const boundsWidth = max.x - min.x;
    const boundsHeight = max.y - min.y;
    assert.ok(Math.abs(boundsWidth - 4) < 1e-6, `raster spans ${boundsWidth} m across`);
    assert.ok(Math.abs(boundsHeight - 3) < 1e-6, `raster spans ${boundsHeight} m down`);

    // The canonical transform: the one `worldPointToPdfMm` applies to every
    // stroke, rebuilt here from the raster's own bounds. If the export placed
    // the image through anything else, the two disagree below.
    const { transform } = computePdfScaleLayout(raster.bounds, 100, 10);
    const pixelMmX = rect.widthMm / raster.width;
    const pixelMmY = rect.heightMm / raster.height;

    // A point inside the upper-right box, plus one in the empty upper-LEFT
    // quadrant. Half a pixel is the whole tolerance: at 150 dpi that is
    // 0.085 mm, well under the thinnest printed line.
    for (const world of [{ x: 3.5, y: 2.5 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }]) {
      const probe = drawingPoint(world.x, world.y);
      const mmViaTransform = worldPointToPdfMm(probe, transform);
      const i = Math.min(
        raster.width - 1,
        Math.floor(((probe.x - min.x) / boundsWidth) * raster.width),
      );
      const j = Math.min(
        raster.height - 1,
        Math.floor(((max.y - probe.y) / boundsHeight) * raster.height),
      );
      const mmViaPixel = {
        x: rect.xMm + ((i + 0.5) / raster.width) * rect.widthMm,
        y: rect.yMm + ((j + 0.5) / raster.height) * rect.heightMm,
      };
      assert.ok(
        Math.abs(mmViaTransform.x - mmViaPixel.x) <= 0.5 * pixelMmX + 1e-9,
        `x drift at world ${world.x},${world.y}: ${mmViaTransform.x} vs ${mmViaPixel.x}`,
      );
      assert.ok(
        Math.abs(mmViaTransform.y - mmViaPixel.y) <= 0.5 * pixelMmY + 1e-9,
        `y drift at world ${world.x},${world.y}: ${mmViaTransform.y} vs ${mmViaPixel.y}`,
      );
    }

    // Registration of the ARITHMETIC is not registration of the CONTENT: the
    // above still holds for an image built upside down. So read the pixels.
    // World y = 2.5 is near the TOP of the paper and carries a box; world
    // y = 2.5 at x = 0.5 is empty; a vertically flipped raster swaps the two.
    const alphaAt = (worldX: number, worldY: number): number => {
      const p = drawingPoint(worldX, worldY);
      const i = Math.min(raster.width - 1, Math.floor(((p.x - min.x) / boundsWidth) * raster.width));
      const j = Math.min(
        raster.height - 1,
        Math.floor(((max.y - p.y) / boundsHeight) * raster.height),
      );
      return raster.pixels[(j * raster.width + i) * 4 + 3];
    };
    assert.equal(alphaAt(3.5, 2.5), 255, 'the upper-right box must paint the upper-right pixels');
    assert.equal(alphaAt(0.5, 0.5), 255, 'the lower-left box must paint the lower-left pixels');
    assert.equal(alphaAt(0.5, 2.5), 0, 'the empty upper-left corner must stay transparent');
    assert.equal(alphaAt(3.5, 0.5), 0, 'the empty lower-right corner must stay transparent');

    // The grid spans the bounds EDGE to edge, which is the property that makes
    // the placement rectangle exact. The upper-right box runs to world x = 4
    // and y = 3, i.e. to the bounds corner, so the very last column and the
    // very first row must carry ink. A grid mapped centre-to-centre (the
    // hidden-line raster's convention, right for sampling a depth buffer and
    // wrong for an image) leaves that outer strip empty and shifts the whole
    // image inwards by up to a pixel.
    const alphaAtPixel = (i: number, j: number): number =>
      raster.pixels[(j * raster.width + i) * 4 + 3];
    const insideRow = Math.floor(((max.y - drawingPoint(4, 2.5).y) / boundsHeight) * raster.height);
    const insideCol = Math.floor(((drawingPoint(3.5, 3).x - min.x) / boundsWidth) * raster.width);
    assert.equal(
      alphaAtPixel(raster.width - 1, insideRow),
      255,
      'the last pixel column must carry the geometry that reaches bounds.max.x',
    );
    assert.equal(
      alphaAtPixel(insideCol, 0),
      255,
      'the first pixel row must carry the geometry that reaches bounds.max.y',
    );
  });

  it('paints the surfaces in their own colour, which is the whole point', async () => {
    // The complaint this feature answers was "these are all colorless non
    // solid". A sheet whose raster is uniformly grey (or empty) would pass
    // every placement test above and still be that same sheet.
    const red = boxMesh();
    red.color = [0.8, 0.2, 0.2, 1];
    const { rasters, deps } = realRasterDeps();
    await generateViewPdf(
      { view: view([red]), camera: CAMERA, section: null, scaleFactor: 100 },
      deps,
    );

    const raster = rasters[0];
    const centre = ((raster.height >> 1) * raster.width + (raster.width >> 1)) * 4;
    // The face towards the camera is head on, so lambert is 1.0 and the pixel
    // is the model colour exactly: round(255 * 0.8) = 204, round(255 * 0.2) = 51.
    assert.deepEqual(
      [raster.pixels[centre], raster.pixels[centre + 1], raster.pixels[centre + 2], raster.pixels[centre + 3]],
      [204, 51, 51, 255],
      'the centre pixel must be the mesh colour at full lambert, opaque',
    );
  });
});
