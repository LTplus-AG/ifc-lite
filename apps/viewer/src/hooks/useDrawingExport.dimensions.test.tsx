/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The drawing panel's real exports carry the dimensions on the cut now drawn
 * and leave out those drawn on another cut: direct SVG, sheet SVG (which the
 * sheet PDF and print render), DXF and the vector PDF. The observation is the
 * file each handler hands to the download.
 *
 * MUTATION TARGETS: drop the `dimensionsToSvg`/`dimensionsToDxfLayers`/
 * `drawDimensionsPdf` call from one writer in `useDrawingExport.ts`, or drop
 * `exportableDimensions` from `useExportDimensionGraphics`.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
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
  DEFAULT_SECTION_CONFIG,
  calculateViewportBounds,
  parseDxf,
  type Drawing2D,
  type DrawingSheet,
  type DxfEntity,
} from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';
import useDrawingExport from './useDrawingExport.js';

const plane = { axis: 'down' as const, position: 50, flipped: false };
/** On the drawn cut, 4 m: prints `4000`. */
const onCut: Dimension2D = { id: 'on', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: 0.5, orientation: 'aligned', plane };
/** Drawn on another cut, 2.5 m: `2500` must appear nowhere. */
const otherCut: Dimension2D = { id: 'off', a: { x: 0, y: 1 }, b: { x: 2.5, y: 1 }, offset: 0.5, orientation: 'aligned', plane: { ...plane, position: 20 } };

const drawing: Drawing2D = {
  config: { ...DEFAULT_SECTION_CONFIG, plane: { axis: 'y', position: 0, flipped: false }, scale: 50 },
  lines: [{
    line: { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
    category: 'projection', visibility: 'visible', entityId: 1, ifcType: 'IfcWall', modelIndex: 0, depth: 0,
  }],
  cutPolygons: [], projectionPolygons: [],
  bounds: { min: { x: 0, y: -1 }, max: { x: 4, y: 2 } },
  stats: {
    cutLineCount: 0, projectionLineCount: 1, hiddenLineCount: 0, silhouetteLineCount: 0,
    polygonCount: 0, totalTriangles: 0, processingTimeMs: 0,
  },
};

function buildSheet(): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY.A3_LANDSCAPE;
  const frame = { style: 'professional' as const, ...FRAME_PRESETS.professional };
  const titleBlock = { ...TITLE_BLOCK_PRESETS.standard, fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })), logo: null };
  return {
    id: 'sheet', name: 'Sheet', paper, frame, titleBlock,
    scaleBar: { ...DEFAULT_SCALE_BAR }, scale: { name: '1:50', factor: 50, useCase: 'test' },
    northArrow: { ...DEFAULT_NORTH_ARROW }, viewportBounds: calculateViewportBounds(paper, frame, titleBlock), revisions: [],
  };
}

type Handlers = ReturnType<typeof useDrawingExport>;

function Harness({ sheet, onReady }: { sheet: boolean; onReady: (h: Handlers) => void }): null {
  const handlers = useDrawingExport({
    drawing,
    displayOptions: { showHiddenLines: true, scale: 50, showScanSection: false, scanSectionOpacity: 0, scanSectionIncludeInExport: false },
    sectionPlane: plane,
    activePresetId: null, entityColorMap: new Map(), overridesEnabled: false, overrideEngine: new GraphicOverrideEngine([]),
    measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
    sheetEnabled: sheet, activeSheet: sheet ? buildSheet() : null,
    dxfUnderlays: [], ifcDataStore: null, coordinateInfo: undefined, scanSection: { points: [] },
  });
  onReady(handlers);
  return null;
}

/** Run one real export handler and return the text of the file it downloads. */
async function exportFile(mime: string, run: (h: Handlers) => void, sheet = false): Promise<string> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let handlers: Handlers | null = null;
  const originalCreate = URL.createObjectURL;
  let resolveBlob!: (blob: Blob) => void;
  const file = new Promise<Blob>((resolve) => { resolveBlob = resolve; });
  URL.createObjectURL = function (obj: Blob | MediaSource): string {
    if (obj instanceof Blob && obj.type === mime) resolveBlob(obj);
    return originalCreate.call(URL, obj);
  };
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness sheet={sheet} onReady={(h) => { handlers = h; }} />);
    });
    let blob: Blob | null = null;
    await act(async () => {
      run(handlers!);
      blob = await file;
    });
    const bytes = new Uint8Array(await (blob as unknown as Blob).arrayBuffer());
    return new TextDecoder('latin1').decode(bytes);
  } finally {
    URL.createObjectURL = originalCreate;
    if (root) await act(async () => { (root as Root).unmount(); });
    container.remove();
  }
}

const textValues = (svg: string) => [...svg.matchAll(/<g class="dimension">.*?<text [^>]*font-size="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
  .map((m) => ({ size: Number(m[1]), value: m[2] }));

describe('drawing exports carry current-cut dimensions only', () => {
  beforeEach(() => {
    useViewerStore.setState({ models: new Map(), dimensions2D: [onCut, otherCut], drawing2DPlane: plane, unitDisplayOverrides: {} });
  });
  afterEach(() => {
    useViewerStore.setState({ dimensions2D: [], drawing2DPlane: null });
  });

  it('direct SVG: 2.5 mm text at 1:50 in drawing metres', async () => {
    const svg = await exportFile('image/svg+xml', (h) => h.handleExportSVG());
    assert.deepEqual(textValues(svg), [{ size: 0.125, value: '4000' }]);
    assert.ok(!svg.includes('>2500<'), 'the other-cut dimension is left out');
  });

  it('sheet SVG (and so sheet PDF and print): 2.5 mm text in paper millimetres', async () => {
    const svg = await exportFile('image/svg+xml', (h) => h.handleExportSVG(), true);
    const texts = textValues(svg);
    assert.equal(texts.length, 1);
    assert.equal(texts[0].value, '4000');
    assert.ok(Math.abs(texts[0].size - 2.5) < 1e-3, `text is 2.5 mm on the sheet, got ${texts[0].size}`);
    assert.ok(svg.indexOf('id="dimensions"') < svg.indexOf('</g>\n\n'), 'inside the clipped drawing content');
  });

  it('DXF: the dimension layer holds the current-cut value only', async () => {
    const dxf = await exportFile('application/dxf', (h) => h.handleExportDXF());
    const entities = parseDxf(dxf).entities.filter((e) => e.layer === 'IFC-DIMENSIONS');
    const texts = entities.filter((e): e is Extract<DxfEntity, { kind: 'text' }> => e.kind === 'text');
    assert.deepEqual(texts.map((t) => t.text), ['4000']);
    assert.ok(Math.abs(texts[0].height - 0.125) < 1e-9, '2.5 mm at 1:50');
    assert.equal(entities.filter((e) => e.kind === 'polyline').length, 5);
  });

  it('vector PDF: the value is real text, the other-cut one absent', async () => {
    const pdf = await exportFile('application/pdf', (h) => h.handleExportPDF(100));
    assert.match(pdf, /\(4000\) Tj/);
    assert.doesNotMatch(pdf, /\(2500\)/);
  });
});
