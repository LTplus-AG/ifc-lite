/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `handleExportPDF` has two writers, and which one runs decides whether the
 * exported PDF is resolution-independent. That split is a documented
 * trade-off (see the long note on the `sheetEnabled && activeSheet` branch
 * in useDrawingExport.ts) and until now nothing pinned it:
 *
 *  - SHEET mode rasterizes `generateSheetSVG()` to a PNG and places that one
 *    image across the paper. This is what fixed #2941 (no frame, title block
 *    or scale bar) and #2942 (not to scale) — the sheet layout only exists
 *    inside `generateSheetSVG`, and jsPDF has no SVG import — at the cost of
 *    a PDF that pixelates under zoom.
 *  - NON-SHEET mode ("as displayed" / scaled, #2042) writes jsPDF vector
 *    primitives and rasterizes nothing.
 *
 * Both halves matter and each protects the other. Without the first, a
 * future "make the sheet vector again" change would quietly reintroduce
 * #2941/#2942 unless it also re-derived the whole sheet layout. Without the
 * second, routing everything through the raster helper — the obvious
 * simplification, since it already handles one case — would silently make
 * the viewer's only true-vector PDF OF THE DRAWING a bitmap, with nothing
 * to catch it: the export still succeeds, still has the right page size,
 * and still looks right at 100%. (`lib/lists/export/pdf.ts` also emits
 * pure vector, through `jspdf-autotable`, but that is a tabular report
 * rather than a drawing; `lib/export/view-pdf/` is a raster.)
 *
 * The observation is what reaches jsPDF: `addImage` (a raster was embedded)
 * versus `lines` (vector primitives were written). Both are spied on
 * `jsPDF.API`, not `jsPDF.prototype` — jsPDF copies its plugin methods onto
 * each instance as own properties at construction time, so patching the
 * prototype patches nothing a real instance calls.
 *
 * `HTMLCanvasElement`'s 2D context and `Image` decoding do not exist under
 * happy-dom, so the sheet path's browser rasterization plumbing is stubbed
 * exactly as useDrawingExport.pdfSheet.test.tsx stubs it. That stub is what
 * makes `addImage` reachable at all here; it does not decide which branch
 * runs, which is the only thing these tests assert on.
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
  type Drawing2D,
  type DrawingSheet,
} from '@ifc-lite/drawing-2d';
import useDrawingExport from './useDrawingExport.js';

// happy-dom has no `window.alert`; the production failure path calls it from
// inside a fire-and-forget async IIFE, where a ReferenceError would hang the
// completion promise below with no visible cause.
(globalThis as unknown as { alert: (msg?: string) => void }).alert = (msg) => {
  // eslint-disable-next-line no-console -- test-only diagnostic for a swallowed export error
  console.error('[handleExportPDF alert]', msg);
};

/** A valid 1x1 PNG so jsPDF's own decoder accepts the stubbed raster. */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** A real, renderable sheet, built from the package's own preset tables the
 *  way `sheetSlice.createDefaultSheet` does. */
function buildSheet(): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY.A3_LANDSCAPE;
  const framePreset = FRAME_PRESETS.professional;
  const titleBlockPreset = TITLE_BLOCK_PRESETS.standard;
  const scale = { name: '1:50', factor: 50, useCase: 'test' };
  const frame = { style: 'professional' as const, ...framePreset };
  const titleBlock = {
    ...titleBlockPreset,
    fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })),
    logo: null,
  };
  const viewportBounds = calculateViewportBounds(paper, frame, titleBlock);
  return {
    id: 'sheet-vector-split',
    name: 'Sheet',
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

/** One 4-metre horizontal line — enough for the non-sheet path to have real
 *  geometry to stroke, so "no `lines` call" can never be a vacuous pass. */
function buildDrawing(): Drawing2D {
  return {
    config: {
      plane: { axis: 'y', position: 0, flipped: false },
      projectionDepth: 10,
      includeHiddenLines: true,
      creaseAngle: 30,
      scale: 50,
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

interface HarnessProps {
  sheetEnabled: boolean;
  activeSheet: DrawingSheet;
  onReady: (fn: (scaleFactor?: number) => void) => void;
}

function Harness({ sheetEnabled, activeSheet, onReady }: HarnessProps): null {
  const { handleExportPDF } = useDrawingExport({
    drawing: buildDrawing(),
    displayOptions: {
      showHiddenLines: true,
      scale: 50,
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
    // The sheet object is handed to BOTH cases on purpose: the only
    // difference between them is the toggle, so a branch that ignored
    // `sheetEnabled` and keyed off `activeSheet` alone could not pass both.
    sheetEnabled,
    activeSheet,
    dxfUnderlays: [],
    ifcDataStore: null,
    coordinateInfo: undefined,
    scanSection: { points: [] },
  });
  onReady(handleExportPDF);
  return null;
}

/** Stub the SVG -> canvas -> PNG plumbing happy-dom cannot do. */
function stubRasterization(): () => void {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  // @ts-expect-error -- test stub, narrower signature than the DOM lib's overloaded getContext
  HTMLCanvasElement.prototype.getContext = function (type: string) {
    if (type === '2d') return { fillStyle: '', fillRect() {}, drawImage() {} };
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
  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    globalThis.Image = OriginalImage;
  };
}

/**
 * Run the real `handleExportPDF` and return the PDF it actually produced, as
 * latin1 text (jsPDF writes these objects uncompressed).
 *
 * The observation is the FILE, not a spy on jsPDF's internals: `downloadFile`
 * ends at `URL.createObjectURL(blob)`, so intercepting that yields the exact
 * bytes the user would have saved. A jsPDF spy is not an option in any case —
 * `lines` and `output` are per-instance own properties installed by the
 * constructor, not entries on `jsPDF.API` (verified directly), so there is
 * nothing shared to patch. The sheet path also creates an object URL for its
 * intermediate SVG blob, hence the `application/pdf` filter.
 */
async function exportPdf(sheetEnabled: boolean): Promise<string> {
  const restoreRaster = stubRasterization();
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let exportFn: ((scaleFactor?: number) => void) | null = null;

  const originalCreate = URL.createObjectURL;
  let resolvePdf!: (blob: Blob) => void;
  const pdfBlob = new Promise<Blob>((resolve) => {
    resolvePdf = resolve;
  });
  URL.createObjectURL = function (obj: Blob | MediaSource): string {
    if (obj instanceof Blob && obj.type === 'application/pdf') resolvePdf(obj);
    return originalCreate.call(URL, obj);
  };

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <Harness
          sheetEnabled={sheetEnabled}
          activeSheet={buildSheet()}
          onReady={(fn) => {
            exportFn = fn;
          }}
        />,
      );
    });
    let blob: Blob | null = null;
    await act(async () => {
      exportFn!();
      blob = await pdfBlob;
    });
    const bytes = new Uint8Array(await (blob as unknown as Blob).arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return text;
  } finally {
    URL.createObjectURL = originalCreate;
    restoreRaster();
    if (root) await act(async () => { (root as Root).unmount(); });
    container.remove();
  }
}

/** jsPDF writes an embedded bitmap as an XObject whose dictionary carries
 *  `/Subtype /Image`; a purely vector document has no such object. Probed
 *  against jsPDF 4.2 both ways — `/XObject` alone appears in both and is
 *  NOT a discriminator. */
const EMBEDDED_IMAGE = '/Subtype /Image';

/** A stroked path in an uncompressed jsPDF content stream: a moveto, a
 *  lineto, and the stroke operator, each on its own line. */
const STROKED_PATH = /\d m\n[-\d. ]+ l\nS\n/;

describe('handleExportPDF — which PDFs are vector and which are raster', () => {
  it('is a RASTER in sheet mode — the documented cost of fixing #2941/#2942', async () => {
    const text = await exportPdf(true);
    assert.ok(
      text.includes(EMBEDDED_IMAGE),
      'a sheet PDF carries its page as an embedded bitmap; if that stops being true, the trade-off note on the sheet branch of handleExportPDF is stale',
    );
    assert.ok(
      !STROKED_PATH.test(text),
      'the sheet path must not ALSO stroke the geometry as vectors — the raster is the whole page, and drawing it twice would double-print it',
    );
  });

  it('stays TRUE VECTOR for the non-sheet "as displayed" / scaled PDF (#2042)', async () => {
    const text = await exportPdf(false);
    assert.ok(
      STROKED_PATH.test(text),
      'the non-sheet PDF must stroke the drawing geometry as vector paths',
    );
    assert.ok(
      !text.includes(EMBEDDED_IMAGE),
      'the non-sheet PDF must embed no bitmap — it is the only resolution-independent PDF of the DRAWING the viewer emits, and routing it through the sheet raster helper would look identical at 100% zoom and only show up under a loupe',
    );
  });
});
