/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing Sheet PDF path rasterizes the sheet SVG at a fixed 300 dpi and
 * sizes the canvas to the sheet's own paper. On the largest papers that asks
 * the browser for a canvas far past what WebKit will allocate:
 *
 *   ARCH E  1219.2 x 914.4 mm -> 14400 x 10800 px = 155,520,000 px
 *   A0      1189   x  841   mm -> 14043 x  9933 px = 139,489,119 px
 *
 * against `CanvasBase::maxCanvasArea()` (Source/WebCore/html/CanvasBase.cpp),
 * which is `8192 * 8192` = 67,108,864 on the iOS family and `16384 * 16384`
 * elsewhere.
 *
 * The failure is not an exception. WebKit's `validateArea()` logs a console
 * warning and returns false; the canvas gets no backing store; `getContext`
 * still hands back a context, `fillRect`/`drawImage` are no-ops, and
 * `toDataURL()` returns the literal string `"data:,"` — see
 * `encodeDataURL(RefPtr<ImageBuffer>&&)` in
 * Source/WebCore/platform/graphics/ImageUtilities.cpp, which returns
 * `"data:,"_s` for a null buffer.
 *
 * `stubWebKitCanvas` below reproduces exactly that contract, so these tests
 * drive the real `handleExportPDF` against a faithful over-cap browser rather
 * than against an assumption.
 *
 * What this file CANNOT observe, and does not claim: how any real browser
 * behaves. No Safari, Chrome or Firefox was run. The over-cap return value is
 * read off WebKit's source, not measured. What WAS measured is only that
 * `"data:,"` is rejected by jsPDF rather than quietly embedded — with
 * jsPDF 4.2 under Node that surfaces as its filesystem-reader error, and with
 * `jsPDF.API.loadFile` stubbed to return `''` (what a browser XHR on
 * `data:,` yields) as `wrong PNG signature`. Either way the user gets a
 * decoder message with no remedy in it. Chrome's and Firefox's own caps, and
 * Safari's separate *total* canvas-memory limit, are not modelled here.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
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
  fitRasterPixels,
  getDefaultPaperSize,
  type Drawing2D,
  type DrawingSheet,
} from '@ifc-lite/drawing-2d';
import { toast } from '@/components/ui/toast';
import useDrawingExport, {
  SHEET_PDF_DPI,
  MAX_SHEET_RASTER_PIXELS,
  MAX_SHEET_RASTER_DIMENSION_PX,
} from './useDrawingExport.js';

/** A tiny, VALID 1x1 PNG so jsPDF's PNG decoder accepts the stubbed raster. */
const TINY_PNG =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/**
 * WebKit's iOS-family cap, quoted from `CanvasBase.cpp` as an expression
 * rather than a flattened constant so the provenance stays readable. This is
 * the lower of WebKit's two caps and therefore the one the exporter has to
 * hold to; the desktop cap is `16384 * 16384`.
 */
const WEBKIT_IOS_MAX_CANVAS_AREA = 8192 * 8192;

// ── fixtures ───────────────────────────────────────────────────────────────

function buildSheet(paperId: string): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY[paperId];
  assert.ok(paper, `unknown paper id ${paperId}`);
  const framePreset = FRAME_PRESETS.professional;
  const titleBlockPreset = TITLE_BLOCK_PRESETS.standard;
  const scale = { name: '1:100', factor: 100, useCase: 'test' };
  const frame = { style: 'professional' as const, ...framePreset };
  const titleBlock = {
    ...titleBlockPreset,
    fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })),
    logo: null,
  };
  const viewportBounds = calculateViewportBounds(paper, frame, titleBlock);
  return {
    id: `sheet-${paperId}`,
    name: `Sheet ${paperId}`,
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

function Harness({
  activeSheet,
  onReady,
}: {
  activeSheet: DrawingSheet;
  onReady: (fn: (scaleFactor?: number) => void) => void;
}): null {
  const { handleExportPDF } = useDrawingExport({
    drawing: buildDrawing(),
    displayOptions: {
      showHiddenLines: true,
      scale: 100,
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

// ── the browser stub ───────────────────────────────────────────────────────

interface CanvasStub {
  /** Every canvas size the exporter asked the browser for, in order. */
  requested: Array<{ width: number; height: number }>;
  restore: () => void;
}

/**
 * @param maxArea over this many pixels the canvas has no backing store and
 *   `toDataURL` returns `"data:,"`, exactly as WebKit does. `Infinity`
 *   models a browser that allocates whatever is asked for.
 */
function stubWebKitCanvas(maxArea: number): CanvasStub {
  const requested: Array<{ width: number; height: number }> = [];

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  // @ts-expect-error -- test stub, narrower than the DOM lib's overloaded getContext
  HTMLCanvasElement.prototype.getContext = function (type: string) {
    // WebKit hands back a live context even when the buffer allocation
    // failed; the paint calls are simply no-ops. A stub that returned null
    // here would make the production `if (!ctx) throw` look like a guard it
    // is not.
    if (type === '2d') return { fillStyle: '', fillRect() {}, drawImage() {} };
    return originalGetContext.call(this, type as '2d');
  };

  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement) {
    requested.push({ width: this.width, height: this.height });
    return this.width * this.height > maxArea ? 'data:,' : TINY_PNG;
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

  return {
    requested,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
      globalThis.Image = OriginalImage;
    },
  };
}

interface ExportOutcome {
  /** `doc.addImage(...)` arguments, or null when the export never got there. */
  addImageArgs: unknown[] | null;
  /** The user-facing failure text, or null on success. */
  alertMessage: string | null;
  /** Every `toast.info` message raised during the export. */
  infoToasts: string[];
  /** Canvas sizes the exporter asked the browser for. */
  requested: Array<{ width: number; height: number }>;
}

async function exportSheet(paperId: string, maxArea: number): Promise<ExportOutcome> {
  const canvas = stubWebKitCanvas(maxArea);
  const infoToasts: string[] = [];
  const originalInfo = toast.info;
  toast.info = (message: string) => {
    infoToasts.push(message);
  };

  let alertMessage: string | null = null;
  let addImageArgs: unknown[] | null = null;
  let settle!: () => void;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const g = globalThis as unknown as { alert?: (msg?: string) => void };
  const originalAlert = g.alert;
  g.alert = (msg?: string) => {
    alertMessage = String(msg);
    settle();
  };

  const { jsPDF } = await import('jspdf');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsPDF copies plugin methods off `API` onto each instance at construction; patching the prototype patches nothing a real instance calls.
  const jsPDFApi = jsPDF.API as any;
  const originalAddImage = jsPDFApi.addImage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capturing jsPDF's variadic addImage overloads
  jsPDFApi.addImage = function (...args: any[]) {
    addImageArgs = args;
    const out = originalAddImage.apply(this, args);
    settle();
    return out;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let exportFn: ((scaleFactor?: number) => void) | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <Harness activeSheet={buildSheet(paperId)} onReady={(fn) => { exportFn = fn; }} />,
      );
    });
    await act(async () => {
      exportFn!();
      await Promise.race([
        finished,
        // A stuck export must fail the assertion below, not hang the runner.
        new Promise<void>((r) => setTimeout(r, 5000)),
      ]);
    });
    return { addImageArgs, alertMessage, infoToasts, requested: canvas.requested };
  } finally {
    jsPDFApi.addImage = originalAddImage;
    toast.info = originalInfo;
    if (originalAlert) g.alert = originalAlert; else delete g.alert;
    canvas.restore();
    if (root) await act(async () => { (root as Root).unmount(); });
    container.remove();
  }
}

// ── the paper the exporter must not degrade ────────────────────────────────

/**
 * Largest registry paper whose 300 dpi raster fits inside WEBKIT's cap.
 *
 * Derived from `WEBKIT_IOS_MAX_CANVAS_AREA` — the number quoted from
 * WebKit's source — and deliberately NOT from `MAX_SHEET_RASTER_PIXELS`.
 * Deriving it from the production constant makes this test move with
 * whatever the production constant says, so a cap set far too TIGHT would
 * degrade real exports and still pass here. Measured: with the budget
 * mutated to `4096 * 4096` the registry-derived version of this test stayed
 * green, and this version does not.
 */
function largestUncappedPaperId(): string {
  const entries = Object.values(PAPER_SIZE_REGISTRY)
    .map((p) => ({
      id: p.id,
      px: Math.ceil((p.widthMm * SHEET_PDF_DPI) / 25.4) * Math.ceil((p.heightMm * SHEET_PDF_DPI) / 25.4),
    }))
    .filter((e) => e.px <= WEBKIT_IOS_MAX_CANVAS_AREA)
    .sort((a, b) => b.px - a.px);
  assert.ok(entries.length > 0, 'no registry paper fits WebKit\'s cap — the arithmetic is wrong');
  return entries[0].id;
}

let alertGuard: (() => void) | undefined;
beforeEach(() => {
  const g = globalThis as unknown as { alert?: (msg?: string) => void };
  if (!g.alert) {
    g.alert = () => {};
    alertGuard = () => { delete g.alert; };
  }
});
afterEach(() => { alertGuard?.(); alertGuard = undefined; });

describe('Drawing Sheet PDF — canvas pixel ceiling', () => {
  it('the constants are WebKit\'s own caps, not round numbers', () => {
    assert.equal(
      MAX_SHEET_RASTER_PIXELS,
      WEBKIT_IOS_MAX_CANVAS_AREA,
      'the pixel budget must be CanvasBase::maxCanvasArea() for the iOS family (8192 * 8192), the lower of WebKit\'s two caps',
    );
    assert.equal(
      MAX_SHEET_RASTER_DIMENSION_PX,
      16_384,
      'the per-side cap must be the side length WebKit\'s non-iOS area cap is expressed as',
    );
    assert.equal(SHEET_PDF_DPI, 300, 'the sheet raster is fixed at 300 dpi — there is no dpi control to point a user at');
  });

  it('A0 asks for a canvas WebKit refuses, and 300 dpi is what makes it so', () => {
    // The arithmetic the ceiling comes from, spelled out rather than pinned
    // to a magic pixel count.
    const a0 = PAPER_SIZE_REGISTRY.A0_LANDSCAPE;
    const uncappedPx =
      Math.ceil((a0.widthMm * SHEET_PDF_DPI) / 25.4) *
      Math.ceil((a0.heightMm * SHEET_PDF_DPI) / 25.4);
    assert.ok(
      uncappedPx > WEBKIT_IOS_MAX_CANVAS_AREA,
      `A0 at ${SHEET_PDF_DPI} dpi is ${uncappedPx} px, which must exceed WebKit's ${WEBKIT_IOS_MAX_CANVAS_AREA}`,
    );

    // ARCH E is bigger still — the true worst case, not A0.
    const archE = PAPER_SIZE_REGISTRY.ARCH_E;
    const archEPx =
      Math.ceil((archE.widthMm * SHEET_PDF_DPI) / 25.4) *
      Math.ceil((archE.heightMm * SHEET_PDF_DPI) / 25.4);
    assert.ok(archEPx > uncappedPx, 'ARCH E must be the largest supported sheet raster, above A0');
  });

  it('exports A0 on a WebKit-capped canvas instead of failing on a blank bitmap', async () => {
    const { addImageArgs, alertMessage, requested } = await exportSheet(
      'A0_LANDSCAPE',
      WEBKIT_IOS_MAX_CANVAS_AREA,
    );

    // RED, before the fix: the exporter asks for 14043 x 9933 px, WebKit
    // hands back "data:," and jsPDF rejects it — `addImageArgs` stays null
    // and `alertMessage` is a decoder complaint with no remedy in it.
    assert.equal(alertMessage, null, `A0 export must succeed; failed with: ${alertMessage}`);
    assert.ok(addImageArgs, 'jsPDF.addImage must have received a raster');

    assert.equal(requested.length, 1, 'exactly one canvas should be rasterized');
    const { width, height } = requested[0];
    assert.ok(
      width * height <= MAX_SHEET_RASTER_PIXELS,
      `the exporter asked for ${width}x${height} = ${width * height} px, over the ${MAX_SHEET_RASTER_PIXELS} px budget`,
    );
    assert.ok(width <= MAX_SHEET_RASTER_DIMENSION_PX && height <= MAX_SHEET_RASTER_DIMENSION_PX);

    // The grid must be the package's own fit, not a second policy.
    const a0 = PAPER_SIZE_REGISTRY.A0_LANDSCAPE;
    const fit = fitRasterPixels(
      a0.widthMm, a0.heightMm, SHEET_PDF_DPI,
      MAX_SHEET_RASTER_PIXELS, MAX_SHEET_RASTER_DIMENSION_PX,
    );
    assert.deepEqual({ width, height }, { width: fit.widthPx, height: fit.heightPx });

    // Capped means blurrier, NEVER mis-scaled: the page and the image
    // rectangle stay the sheet's own millimetres.
    const [, , , , widthMm, heightMm] = addImageArgs as [unknown, unknown, unknown, unknown, number, number];
    assert.equal(widthMm, a0.widthMm, 'a capped raster must still print at full paper width');
    assert.equal(heightMm, a0.heightMm, 'a capped raster must still print at full paper height');
  });

  it('tells the user the resolution dropped — a capped export is never silent', async () => {
    const { infoToasts } = await exportSheet('A0_LANDSCAPE', WEBKIT_IOS_MAX_CANVAS_AREA);
    assert.equal(infoToasts.length, 1, `expected one notice about the reduced raster; got ${JSON.stringify(infoToasts)}`);

    const a0 = PAPER_SIZE_REGISTRY.A0_LANDSCAPE;
    const fit = fitRasterPixels(
      a0.widthMm, a0.heightMm, SHEET_PDF_DPI,
      MAX_SHEET_RASTER_PIXELS, MAX_SHEET_RASTER_DIMENSION_PX,
    );
    const reported = Math.floor(fit.effectiveDpi);
    assert.match(
      infoToasts[0],
      new RegExp(`\\b${reported}\\b`),
      'the notice must state the dpi actually delivered',
    );
    assert.match(infoToasts[0], new RegExp(`\\b${SHEET_PDF_DPI}\\b`), 'the notice must state what was asked for');
    // `Math.round` would render 299.53 dpi as "reduced from 300 to 300".
    assert.notEqual(reported, SHEET_PDF_DPI, 'the reported dpi must never equal the requested one');
  });

  it('does NOT touch the default sheet paper', async () => {
    // The paper every sheet starts on (`getDefaultPaperSize()`), named from
    // outside the cap arithmetic entirely. If a future cap degrades THIS
    // export, the feature's own default has regressed.
    const paper = getDefaultPaperSize();
    const { alertMessage, infoToasts, requested } = await exportSheet(paper.id, Infinity);

    assert.equal(alertMessage, null, `the default paper must export cleanly; failed with: ${alertMessage}`);
    assert.deepEqual(infoToasts, [], 'the default paper must raise no reduction notice');
    assert.deepEqual(requested[0], {
      width: Math.ceil((paper.widthMm * SHEET_PDF_DPI) / 25.4),
      height: Math.ceil((paper.heightMm * SHEET_PDF_DPI) / 25.4),
    }, `the default paper must still rasterize at the full ${SHEET_PDF_DPI} dpi`);
  });

  it('does NOT touch the largest paper that already worked', async () => {
    const paperId = largestUncappedPaperId();
    const paper = PAPER_SIZE_REGISTRY[paperId];

    // Not the cap: a browser that allocates anything. If the guard fired here
    // it would be degrading an export that has no reason to be degraded.
    const { addImageArgs, alertMessage, infoToasts, requested } = await exportSheet(paperId, Infinity);

    assert.equal(alertMessage, null, `${paperId} must export cleanly; failed with: ${alertMessage}`);
    assert.ok(addImageArgs, 'jsPDF.addImage must have received a raster');
    assert.deepEqual(infoToasts, [], `${paperId} is inside the cap and must raise no reduction notice`);
    assert.deepEqual(requested[0], {
      width: Math.ceil((paper.widthMm * SHEET_PDF_DPI) / 25.4),
      height: Math.ceil((paper.heightMm * SHEET_PDF_DPI) / 25.4),
    }, `${paperId} must still rasterize at the full ${SHEET_PDF_DPI} dpi`);
  });

  it('names a remedy when the canvas comes back blank anyway', async () => {
    // Under the pixel budget and STILL blank: Safari enforces a separate
    // total-canvas-memory limit, and any browser can fail an allocation on a
    // low-memory device. The cap cannot rule that out, so the blank bitmap
    // must be recognised rather than handed to jsPDF, whose "wrong PNG
    // signature" tells a user nothing they can act on.
    const { addImageArgs, alertMessage } = await exportSheet('A4_LANDSCAPE', 0);

    assert.equal(addImageArgs, null, 'a blank bitmap must never reach jsPDF');
    assert.ok(alertMessage, 'the user must be told the export failed');
    assert.doesNotMatch(
      alertMessage!,
      /PNG signature/i,
      'jsPDF\'s decoder message is not an explanation the user can act on',
    );
    assert.match(alertMessage!, /SVG/i, 'the message must name the vector export as the way out');
  });
});
