/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issues #2941/#2942: `handleExportPDF` never checked `sheetEnabled` /
 * `activeSheet` at all — every PDF export ran the raw-drawing "v1" path
 * (useDrawingExport.ts, `handleExportPDF`), which lays geometry out with
 * `computePdfSectionLayout` (a plain fit-to-page) at `displayOptions.scale`
 * (the on-screen "as displayed" value), never the sheet's own paper size
 * (`activeSheet.paper`) or scale (`activeSheet.scale.factor`). SVG/DXF/Print
 * all branch on `sheetEnabled && activeSheet` (see `handleExportSVG` in the
 * same file); PDF alone didn't, so with a Drawing Sheet active the exported
 * PDF had no frame/title block/scale bar (#2941) and was laid out at
 * whatever `displayOptions.scale` happened to be, not the sheet's scale
 * (#2942) — one root cause for both reports.
 *
 * This test mounts the REAL `useDrawingExport` hook (not a reimplementation)
 * with `sheetEnabled: true` and a real `DrawingSheet` built from the same
 * `@ifc-lite/drawing-2d` building blocks `sheetSlice.createDefaultSheet`
 * uses, then calls the real `handleExportPDF()` and inspects what actually
 * reaches `jsPDF`:
 *
 *  - the PDF page (`doc.addImage` width/height) must be the SHEET's own
 *    paper size, not a fit-to-page size derived from the drawing bounds.
 *  - the rasterized image must be built from the SAME svg the sheet SVG/
 *    Print exporters emit (frame + scale-bar markers present).
 *  - a known-length line (4m) must land on paper at the distance implied by
 *    the sheet's OWN scale (`1000 / scale.factor` mm per metre) — proving
 *    the export is actually to scale, and that changing the sheet's scale
 *    changes the output (not stuck at one hardcoded value).
 *
 * `HTMLCanvasElement`'s 2D context and `Image` decoding don't exist under
 * happy-dom (probed directly: `canvas.getContext('2d')` returns `null`
 * here), so the rasterization step (SVG -> canvas -> PNG) is stubbed; that
 * step is pure browser plumbing with nothing sheet-specific in it. Every
 * sheet-specific number this test asserts on (paper size, svg content, the
 * to-scale line span) comes out of the REAL production code path.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  GraphicOverrideEngine,
  PAPER_SIZE_REGISTRY,
  FRAME_PRESETS,
  TITLE_BLOCK_PRESETS,
  DEFAULT_TITLE_BLOCK_FIELDS,
  DEFAULT_SCALE_BAR,
  DEFAULT_NORTH_ARROW,
  calculateViewportBounds,
  calculateOptimalScaleBarLength,
  calculateDrawingTransformForAxis,
  type Drawing2D,
  type DrawingSheet,
} from '@ifc-lite/drawing-2d';
import useDrawingExport from './useDrawingExport.js';

// happy-dom has no `window.alert` — the production error path calls it on
// failure, which would otherwise throw `ReferenceError: alert is not
// defined` inside the fire-and-forget async IIFE and hang this test's
// `addImageCalled` promise forever with no visible cause.
(globalThis as unknown as { alert: (msg?: string) => void }).alert = (msg) => {
  // eslint-disable-next-line no-console -- test-only diagnostic for a swallowed export error
  console.error('[handleExportPDF alert]', msg);
};
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console -- test-only diagnostic
  console.error('[unhandledRejection]', reason);
});

// A tiny, VALID 1x1 PNG (red pixel) so jsPDF's own PNG decoder accepts it —
// only its bytes matter to jsPDF, not its pixel size (the page/image
// dimensions the test asserts on are the explicit `widthMm`/`heightMm`
// arguments the production code passes to `addImage`, not anything derived
// from the fake image itself).
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** Build a real, renderable `DrawingSheet` the same way
 *  `sheetSlice.createDefaultSheet` does — reusing the package's own preset
 *  tables rather than casting a stub object past the interface, so
 *  `renderFrame`/`renderTitleBlock`/`renderScaleBar` (all called for real by
 *  `generateSheetSVG`) get everything they read. */
function buildSheet(paperId: string, scaleFactor: number, scaleName: string): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY[paperId];
  const framePreset = FRAME_PRESETS.professional;
  const titleBlockPreset = TITLE_BLOCK_PRESETS.standard;
  const scale = { name: scaleName, factor: scaleFactor, useCase: 'test' };

  const frame = { style: 'professional' as const, ...framePreset };
  const titleBlock = {
    ...titleBlockPreset,
    fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })),
    logo: null,
  };

  const viewportBounds = calculateViewportBounds(paper, frame, titleBlock);

  return {
    id: `sheet-${paperId}-${scaleFactor}`,
    name: `Sheet ${scaleName}`,
    paper,
    frame,
    titleBlock,
    scaleBar: {
      ...DEFAULT_SCALE_BAR,
      totalLengthM: calculateOptimalScaleBarLength(scale.factor, viewportBounds.width * 0.3),
    },
    scale,
    northArrow: { ...DEFAULT_NORTH_ARROW },
    viewportBounds,
    revisions: [],
  };
}

/** One 4-metre horizontal line, nothing else — small enough to fit inside
 *  any of these paper sizes at any of the scales under test without the
 *  viewport's "shrink to fit" clamp engaging (verified per-fixture below),
 *  so `calculateDrawingTransform`'s `scaleFactor` output is the sheet's
 *  exact nominal scale, not a fitted-down one. */
function buildDrawing(): Drawing2D {
  return {
    config: {
      plane: { axis: 'y', position: 0, flipped: false },
      projectionDepth: 10,
      includeHiddenLines: true,
      creaseAngle: 30,
      scale: 100,
    },
    lines: [
      {
        line: { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
        category: 'projection',
        visibility: 'visible',
        entityId: 1,
        ifcType: 'IfcWall',
        modelIndex: 0,
        depth: 0,
      },
    ],
    cutPolygons: [],
    projectionPolygons: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: 4, y: 0 } },
    stats: {
      cutLineCount: 0,
      projectionLineCount: 1,
      hiddenLineCount: 0,
      silhouetteLineCount: 0,
      polygonCount: 0,
      totalTriangles: 0,
      processingTimeMs: 0,
    },
  };
}

/** A 10m x 6m plan ('down') section whose Y bounds are NOT symmetric about
 *  zero (y: 2..8, matching the #2940 report of a 10x6m plan section landing
 *  120mm off-centre) — the case `calculateDrawingTransformForAxis`'s
 *  unflipped correction exists for. `buildDrawing()` above is deliberately
 *  degenerate on Y (a single y=0 line) and cannot exercise this: the
 *  correction term `(maxY + minY) * scaleFactor` is zero whenever minY ===
 *  maxY, so a composition bug that dropped the correction would still pass
 *  every existing assertion in this file. */
function buildPlanDrawing(): Drawing2D {
  return {
    config: {
      plane: { axis: 'y', position: 0, flipped: false },
      projectionDepth: 10,
      includeHiddenLines: true,
      creaseAngle: 30,
      scale: 100,
    },
    lines: [
      {
        line: { start: { x: 0, y: 2 }, end: { x: 10, y: 8 } },
        category: 'projection',
        visibility: 'visible',
        entityId: 1,
        ifcType: 'IfcWall',
        modelIndex: 0,
        depth: 0,
      },
    ],
    cutPolygons: [],
    projectionPolygons: [],
    bounds: { min: { x: 0, y: 2 }, max: { x: 10, y: 8 } },
    stats: {
      cutLineCount: 0,
      projectionLineCount: 1,
      hiddenLineCount: 0,
      silhouetteLineCount: 0,
      polygonCount: 0,
      totalTriangles: 0,
      processingTimeMs: 0,
    },
  };
}

interface HarnessProps {
  activeSheet: DrawingSheet;
  drawing: Drawing2D;
  onReady: (fn: (scaleFactor?: number) => void) => void;
}

function Harness({ activeSheet, drawing, onReady }: HarnessProps): null {
  const { handleExportPDF } = useDrawingExport({
    drawing,
    displayOptions: {
      showHiddenLines: true,
      scale: 999999, // deliberately NOT the sheet's scale — if this leaks into the sheet path, the measured span assertion below fails loudly.
      showScanSection: false,
      scanSectionOpacity: 0,
      scanSectionIncludeInExport: false,
    },
    sectionPlane: { axis: 'down', position: 50, flipped: false },
    activePresetId: null,
    entityColorMap: new Map(),
    overridesEnabled: false,
    overrideEngine: new GraphicOverrideEngine(),
    measure2DResults: [],
    polygonArea2DResults: [],
    textAnnotations2D: [],
    cloudAnnotations2D: [],
    sheetEnabled: true,
    activeSheet,
    dxfUnderlays: [],
    ifcDataStore: null,
    coordinateInfo: undefined,
    scanSection: { points: [] },
  });
  onReady(handleExportPDF);
  return null;
}

/** Stub the browser rasterization plumbing (SVG -> canvas -> PNG) that
 *  happy-dom cannot do (`canvas.getContext('2d')` is `null` here), while
 *  capturing the svg string and the canvas pixel size it was asked to
 *  rasterize at, for inspection. */
function stubRasterization(): {
  capturedSvg: { value: string | null };
  restore: () => void;
} {
  const capturedSvg: { value: string | null } = { value: null };

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  // @ts-expect-error -- test stub, narrower signature than the DOM lib's overloaded getContext
  HTMLCanvasElement.prototype.getContext = function (type: string) {
    if (type === '2d') {
      return { fillStyle: '', fillRect() {}, drawImage() {} };
    }
    return originalGetContext.call(this, type as '2d');
  };

  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function () {
    return `data:image/png;base64,${TINY_PNG_B64}`;
  };

  const OriginalImage = globalThis.Image;
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  // @ts-expect-error -- test stub replacing the global Image constructor
  globalThis.Image = FakeImage;

  const OriginalBlob = globalThis.Blob;
  class SpyBlob extends OriginalBlob {
    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      if (options?.type?.includes('svg') && typeof parts[0] === 'string') {
        capturedSvg.value = parts[0];
      }
    }
  }
  globalThis.Blob = SpyBlob as unknown as typeof Blob;

  return {
    capturedSvg,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
      globalThis.Image = OriginalImage;
      globalThis.Blob = OriginalBlob;
    },
  };
}

async function exportPdfForSheet(sheet: DrawingSheet, drawing: Drawing2D = buildDrawing()): Promise<{
  addImageArgs: unknown[];
  svg: string;
}> {
  const rasterStub = stubRasterization();
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let exportFn: ((scaleFactor?: number) => void) | null = null;

  // jsPDF's plugin methods (addImage included) are copied onto each
  // instance as an OWN property at construction time from `jsPDF.API`
  // (verified directly: `jsPDF.prototype.addImage` doesn't exist —
  // `Object.prototype.hasOwnProperty.call(jsPDF.prototype, 'addImage')` is
  // `false` — but `jsPDF.API.addImage` does, and patching THAT is what a
  // freshly-constructed instance picks up). Patching `jsPDF.prototype`
  // silently patches nothing a real instance ever calls.
  const { jsPDF } = await import('jspdf');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsPDF's own `.d.ts` doesn't declare `API` as holding `addImage`, but it does at runtime (verified above); this is a test-only spy, not production code.
  const jsPDFApi = jsPDF.API as any;
  const originalAddImage = jsPDFApi.addImage;
  let resolveAddImage!: (args: unknown[]) => void;
  const addImageCalled = new Promise<unknown[]>((resolve) => {
    resolveAddImage = resolve;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capturing jsPDF's own variadic addImage overloads
  jsPDFApi.addImage = function (...args: any[]) {
    resolveAddImage(args);
    return originalAddImage.apply(this, args);
  };

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <Harness
          activeSheet={sheet}
          drawing={drawing}
          onReady={(fn) => {
            exportFn = fn;
          }}
        />,
      );
    });

    await act(async () => {
      exportFn!();
      await addImageCalled;
    });

    const addImageArgs = await addImageCalled;
    if (rasterStub.capturedSvg.value === null) {
      throw new Error('expected the sheet SVG to have been rasterized (Blob spy never fired)');
    }
    return { addImageArgs, svg: rasterStub.capturedSvg.value };
  } finally {
    jsPDFApi.addImage = originalAddImage;
    rasterStub.restore();
    if (root) await act(async () => { (root as Root).unmount(); });
    container.remove();
  }
}

/** Parse the first `<line x1="..." y1="..." x2="..." y2="...">` inside the
 *  `drawing-lines` group and return the mm distance between its endpoints —
 *  the on-paper span of the fixture's 4m line. */
function measureLineSpanMm(svg: string): number {
  const match = svg.match(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/);
  assert.ok(match, `expected a <line> element in the exported sheet svg; got:\n${svg.slice(0, 2000)}`);
  const [, x1, y1, x2, y2] = match.map(Number) as unknown as [never, number, number, number, number];
  return Math.hypot(x2 - x1, y2 - y1);
}

/** Parse the first `<line x1="..." y1="..." x2="..." y2="...">` inside the
 *  exported sheet svg and return its endpoints in paper mm. */
function parseLineEndpoints(svg: string): { x1: number; y1: number; x2: number; y2: number } {
  const match = svg.match(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/);
  assert.ok(match, `expected a <line> element in the exported sheet svg; got:\n${svg.slice(0, 2000)}`);
  const [, x1, y1, x2, y2] = match.map(Number) as unknown as [never, number, number, number, number];
  return { x1, y1, x2, y2 };
}

describe('handleExportPDF — Drawing Sheet mode (#2941/#2942)', () => {
  it('sizes the PDF page to the SHEET paper, not a fit-to-page layout', async () => {
    const sheet = buildSheet('A3_LANDSCAPE', 50, '1:50');
    const { addImageArgs } = await exportPdfForSheet(sheet);
    // doc.addImage(pngDataUrl, 'PNG', 0, 0, widthMm, heightMm)
    const [, , , , widthMm, heightMm] = addImageArgs as [unknown, unknown, unknown, unknown, number, number];
    assert.equal(widthMm, sheet.paper.widthMm, 'PDF image width must equal the sheet paper width');
    assert.equal(heightMm, sheet.paper.heightMm, 'PDF image height must equal the sheet paper height');
  });

  it('rasterizes the sheet SVG — frame and scale-bar markers present (#2941)', async () => {
    const sheet = buildSheet('A3_LANDSCAPE', 50, '1:50');
    const { svg } = await exportPdfForSheet(sheet);
    assert.match(svg, /id="drawing-frame"/, 'exported PDF must be built from the sheet svg (frame missing = #2941)');
    assert.match(svg, /id="title-block-scale-bar"/, 'exported PDF must be built from the sheet svg (scale bar missing = #2941)');
  });

  it('is laid out at the SHEET scale, not displayOptions.scale, and changes with it (#2942)', async () => {
    // 1:50 -> 1000/50 = 20mm per metre -> a 4m line spans 80mm on paper.
    const sheetA = buildSheet('A3_LANDSCAPE', 50, '1:50');
    const { svg: svgA } = await exportPdfForSheet(sheetA);
    const spanA = measureLineSpanMm(svgA);
    assert.ok(
      Math.abs(spanA - 80) < 0.01,
      `at 1:50 a 4m line must span 80mm on paper; measured ${spanA}mm`,
    );

    // 1:200 -> 1000/200 = 5mm per metre -> the SAME 4m line spans 20mm.
    const sheetB = buildSheet('A2_LANDSCAPE', 200, '1:200');
    const { svg: svgB } = await exportPdfForSheet(sheetB);
    const spanB = measureLineSpanMm(svgB);
    assert.ok(
      Math.abs(spanB - 20) < 0.01,
      `at 1:200 a 4m line must span 20mm on paper; measured ${spanB}mm`,
    );

    // The reported bug: "scale bar showing 10 cm... not correct in any
    // scale" — i.e. the export doesn't move at all when the sheet's scale
    // changes. Assert the two measured spans actually differ.
    assert.notEqual(spanA, spanB, 'changing the sheet scale must change the on-paper span — it must not be stuck at one value');
  });

  it('centers a plan-axis (down) drawing using the corrected, unflipped transform — the #2940 fix composed with #2941/#2942', async () => {
    // The PDF path (`handleExportPDF`) delegates to `generateSheetSVG`,
    // which the #2940 fix rewrote to call `calculateDrawingTransformForAxis`
    // with `flipY = (axis !== 'down')` instead of the raw, always-flipped
    // `calculateDrawingTransform`. For a 'down' (plan) section whose Y
    // bounds are not symmetric about zero, that changes where the drawing
    // lands on paper. This test proves the PDF export actually inherits
    // that correction, not just the SVG/print path #2940 shipped with.
    const sheet = buildSheet('A3_LANDSCAPE', 100, '1:100');
    const drawing = buildPlanDrawing();
    const { svg } = await exportPdfForSheet(sheet, drawing);
    const { x1, y1, x2, y2 } = parseLineEndpoints(svg);

    // Expected transform: same building blocks `generateSheetSVG` uses
    // (sheet.viewportBounds, sheet.scale), with flipY=false for the 'down'
    // axis — mirroring useDrawingExport.ts's own
    // `flipY = currentAxis !== 'down'`.
    const expected = calculateDrawingTransformForAxis(
      { minX: drawing.bounds.min.x, minY: drawing.bounds.min.y, maxX: drawing.bounds.max.x, maxY: drawing.bounds.max.y },
      sheet.viewportBounds,
      sheet.scale,
      false
    );
    const expectedX1 = drawing.bounds.min.x * expected.scaleFactor + expected.translateX;
    const expectedY1 = drawing.bounds.min.y * expected.scaleFactor + expected.translateY;
    const expectedX2 = drawing.bounds.max.x * expected.scaleFactor + expected.translateX;
    const expectedY2 = drawing.bounds.max.y * expected.scaleFactor + expected.translateY;

    assert.ok(Math.abs(x1 - expectedX1) < 0.01, `x1: expected ${expectedX1}, got ${x1}`);
    assert.ok(Math.abs(y1 - expectedY1) < 0.01, `y1: expected ${expectedY1}, got ${y1}`);
    assert.ok(Math.abs(x2 - expectedX2) < 0.01, `x2: expected ${expectedX2}, got ${x2}`);
    assert.ok(Math.abs(y2 - expectedY2) < 0.01, `y2: expected ${expectedY2}, got ${y2}`);

    // Sanity: prove this fixture actually distinguishes the corrected
    // transform from the uncorrected one (else the assertions above could
    // pass by coincidence). The uncorrected translateY differs by
    // (maxY + minY) * scaleFactor = (8 + 2) * scaleFactor != 0.
    const uncorrectedTranslateYDelta = (drawing.bounds.max.y + drawing.bounds.min.y) * expected.scaleFactor;
    assert.ok(
      Math.abs(uncorrectedTranslateYDelta) > 1,
      `fixture does not distinguish corrected vs. uncorrected transform (delta ${uncorrectedTranslateYDelta}mm) — strengthen it`
    );
  });
});
