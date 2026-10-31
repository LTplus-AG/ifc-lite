/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scaled (non-sheet) section PDF from #2042 drew cut polygons as black
 * outlines only, while the SVG export of the same section was coloured.
 * These tests read the file the user would download and check the cut
 * polygon is filled with the colour the SVG export uses, holes included,
 * that override stroke colours reach the outline, and that a bad override
 * colour degrades one polygon instead of aborting the export.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GraphicOverrideEngine, type Drawing2D, type GraphicOverrideRule } from '@ifc-lite/drawing-2d';
import useDrawingExport from './useDrawingExport.js';
import { pdfColor } from '@/lib/export/pdf-color';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { waitFor } from '@/test/render.js';

/** A 4x3 m wall cut with a 1x1 m opening. */
function buildDrawing({ polygonColor, noOuter = false, nanVertex, cutLine = false }: ExportOptions = {}): Drawing2D {
  const nanIn = (ring: 'hole' | 'outer') => (nanVertex === ring || nanVertex === 'all' ? Number.NaN : 4);
  return {
    config: {
      plane: { axis: 'y', position: 0, flipped: false },
      projectionDepth: 10,
      includeHiddenLines: true,
      creaseAngle: 30,
      scale: 50,
    },
    lines: cutLine
      ? [{ line: { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } }, category: 'cut', visibility: 'visible', entityId: 7, ifcType: 'IfcWall', modelIndex: 0, depth: 0 }]
      : [],
    cutPolygons: [
      {
        polygon: {
          outer: noOuter ? [] : [{ x: 0, y: 0 }, { x: nanIn('outer'), y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
          holes: [[{ x: 1, y: 1 }, { x: nanIn('hole') / 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }]],
        },
        ifcType: 'IfcWall',
        entityId: 7,
        modelIndex: 0,
        isCut: true,
        ...(polygonColor ? { color: polygonColor } : {}),
      },
    ],
    projectionPolygons: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: 4, y: 3 } },
    stats: {
      cutLineCount: 0,
      projectionLineCount: 0,
      hiddenLineCount: 0,
      silhouetteLineCount: 0,
      polygonCount: 1,
      totalTriangles: 0,
      processingTimeMs: 0,
    },
  };
}

interface ExportOptions {
  activePresetId?: string | null;
  entityColorMap?: Map<number, [number, number, number, number]>;
  overrideRules?: GraphicOverrideRule[];
  polygonColor?: [number, number, number, number];
  /** Loop reconstruction lost the outer ring; only the hole survives. */
  noOuter?: boolean;
  /** Corrupt geometry: a NaN vertex in the hole, the outer ring, or both. */
  nanVertex?: 'hole' | 'outer' | 'all';
  /** Also carry the wall's bottom edge as a `cut` line. */
  cutLine?: boolean;
}

type Format = 'pdf' | 'svg';
const MIME: Record<Format, string> = { pdf: 'application/pdf', svg: 'image/svg+xml' };

function Harness({ format, options, onReady }: { format: Format; options: ExportOptions; onReady: (fn: () => void) => void }): null {
  const { handleExportPDF, handleExportSVG } = useDrawingExport({
    drawing: buildDrawing(options),
    displayOptions: {
      showHiddenLines: true,
      scale: 50,
      showScanSection: false,
      scanSectionOpacity: 0,
      scanSectionIncludeInExport: false,
    },
    sectionPlane: { axis: 'down', position: 50, flipped: false },
    activePresetId: options.activePresetId ?? null,
    entityColorMap: options.entityColorMap ?? new Map(),
    overridesEnabled: options.overrideRules !== undefined,
    overrideEngine: new GraphicOverrideEngine(options.overrideRules ?? []),
    measure2DResults: [],
    polygonArea2DResults: [],
    textAnnotations2D: [],
    cloudAnnotations2D: [],
    sheetEnabled: false,
    activeSheet: null,
    dxfUnderlays: [],
    ifcDataStore: null,
    coordinateInfo: undefined,
    scanSection: { points: [] },
  });
  onReady(format === 'pdf' ? () => handleExportPDF() : handleExportSVG);
  return null;
}

/** Run the real export and return the downloaded file as latin1 text. A
 *  failed export throws its journal detail instead of hanging. */
async function exportFile(format: Format, options: ExportOptions = {}): Promise<string> {
  useActivityJournal.setState({ jobs: [] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let exportFn: (() => void) | null = null;
  const originalCreate = URL.createObjectURL;
  let blob: Blob | null = null;
  URL.createObjectURL = function (obj: Blob | MediaSource): string {
    if (obj instanceof Blob && obj.type === MIME[format]) blob = obj;
    return originalCreate.call(URL, obj);
  };
  const failedJob = () => useActivityJournal.getState().jobs.find((j) => j.outcome === 'failed');
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness format={format} options={options} onReady={(fn) => { exportFn = fn; }} />);
    });
    await act(async () => { exportFn!(); });
    await waitFor(() => blob !== null || failedJob() !== undefined, `the ${format} export finished`);
    const job = failedJob();
    if (job) throw new Error(`export failed: ${job.detail}`);
    return Buffer.from(await (blob as unknown as Blob).arrayBuffer()).toString('latin1');
  } finally {
    URL.createObjectURL = originalCreate;
    if (root) await act(async () => { (root as Root).unmount(); });
    container.remove();
  }
}
const exportPdf = (options?: ExportOptions) => exportFile('pdf', options);

/** Whether a fill (`rg`/`g`) or stroke (`RG`/`G`) operator sets `hex`.
 *  jsPDF writes channels to 2 decimals and a grey as one `g`/`G` channel. */
function setsColor(text: string, kind: 'fill' | 'stroke', hex: string): boolean {
  const [rgb, grey] = kind === 'fill' ? ['rg', 'g'] : ['RG', 'G'];
  const num = '(\\d+\\.?\\d*|\\.\\d+)';
  const ops = new RegExp(`^(?:${num} ${num} ${num} ${rgb}|${num} ${grey})$`, 'gm');
  const n = parseInt(hex.slice(1), 16);
  const want = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return [...text.matchAll(ops)].some((m) => {
    const got = m[4] !== undefined ? [m[4], m[4], m[4]] : [m[1], m[2], m[3]];
    return got.every((v, i) => Math.abs(parseFloat(v) - want[i]) <= 0.006);
  });
}

/** A filled path with two closed subpaths (outer ring + hole), even-odd. */
const EVEN_ODD_TWO_RINGS = /m\n(?:[-\d. ]+ l\n)+h\n[-\d. ]+ m\n(?:[-\d. ]+ l\n)+h\nf\*\n/;

const wallRule = (style: GraphicOverrideRule['style']): GraphicOverrideRule => ({
  id: 'walls',
  name: 'Walls',
  enabled: true,
  priority: 1,
  criteria: { type: 'ifcType', ifcTypes: ['IfcWall'] },
  style,
});

describe('handleExportPDF (non-sheet) fills cut polygons like the SVG export', () => {
  it('fills with the IFC type colour, even-odd so the opening stays empty', async () => {
    const text = await exportPdf();
    assert.ok(setsColor(text, 'fill', '#b0b0b0'), 'IfcWall fill colour #b0b0b0 is set');
    assert.match(text, EVEN_ODD_TWO_RINGS, 'outer ring and hole are filled as one even-odd path');
    assert.ok(text.includes('h\nS\n'), 'the outline is still stroked');
  });

  it('uses mesh material colours and their opacity with the 3D colours preset', async () => {
    const text = await exportPdf({
      activePresetId: 'preset-3d-colors',
      entityColorMap: new Map([[7, [1, 0, 0, 0.5]]]),
    });
    assert.ok(setsColor(text, 'fill', '#ff0000'), 'material red is the fill');
    assert.match(text, /\/ca 0\.5\b/, 'material alpha becomes the fill opacity');
  });

  it('prefers the per-layer polygon colour over the entity colour, as the canvas does', async () => {
    const text = await exportPdf({
      activePresetId: 'preset-3d-colors',
      entityColorMap: new Map([[7, [1, 0, 0, 1]]]),
      polygonColor: [0, 0, 1, 1],
    });
    assert.ok(setsColor(text, 'fill', '#0000ff'), 'layer blue is the fill');
    assert.ok(!setsColor(text, 'fill', '#ff0000'), 'entity red is not used');
  });

  it('applies override fill, stroke colour and line weight', async () => {
    const text = await exportPdf({
      overrideRules: [wallRule({ fillColor: '#FFCDD2', strokeColor: '#1976D2', lineWeight: 0.7 })],
    });
    assert.ok(setsColor(text, 'fill', '#ffcdd2'), 'override fill colour');
    assert.ok(setsColor(text, 'stroke', '#1976d2'), 'override stroke colour');
    assert.ok(!setsColor(text, 'fill', '#b0b0b0'), 'type colour is replaced, not drawn as well');
    assert.match(text, /^1\.98\d* w$/m, '0.7 mm override line weight (1.98 pt)');
  });

  it('turns an #RRGGBBAA override into a colour jsPDF accepts plus opacity', async () => {
    const text = await exportPdf({ overrideRules: [wallRule({ fillColor: '#00FF0080' })] });
    assert.ok(setsColor(text, 'fill', '#00ff00'), 'alpha byte is stripped from the colour');
    assert.match(text, /\/ca 0\.5\b/, 'alpha byte 0x80 becomes the fill opacity');
  });
});

describe('handleExportPDF (non-sheet) edge cases', () => {
  it('falls back to the type colour and black for colours jsPDF cannot take', async () => {
    const text = await exportPdf({ overrideRules: [wallRule({ fillColor: '#12', strokeColor: 'bogus' })] });
    assert.ok(setsColor(text, 'fill', '#b0b0b0'), 'unfinished #12 fill falls back to the IfcWall colour');
    assert.ok(setsColor(text, 'stroke', '#000000'), 'unparseable stroke falls back to black');
    assert.ok(text.includes('h\nS\n'), 'the outline is still drawn');
    assert.ok(!/#12|bogus/.test(text), 'the raw colour never reaches the content stream');
  });

  it('draws nothing for transparent / none, as the canvas and SVG do', async () => {
    const text = await exportPdf({ overrideRules: [wallRule({ fillColor: 'none', strokeColor: 'transparent' })] });
    assert.ok(!text.includes('f*'), 'no fill');
    assert.ok(!text.includes('h\nS\n'), 'no outline');
  });

  it('carries #RRGGBBAA stroke alpha into the stroke opacity', async () => {
    const text = await exportPdf({ overrideRules: [wallRule({ strokeColor: '#1976D280' })] });
    assert.ok(setsColor(text, 'stroke', '#1976d2'));
    assert.match(text, /\/CA 0\.5\b/, 'alpha byte 0x80 becomes the stroke opacity');
  });

  it('outlines but does not fill a polygon whose outer ring was lost', async () => {
    const text = await exportPdf({ noOuter: true });
    assert.ok(!text.includes('f*'), 'the opening is not painted solid');
    assert.ok(text.includes('h\nS\n'), 'the surviving ring is still stroked, as before fills existed');
  });

  it('never writes a negative or NaN line width; zero hides the outline', async () => {
    for (const lineWeight of [-1, 0, Number.NaN]) {
      const text = await exportPdf({ overrideRules: [wallRule({ lineWeight })] });
      assert.doesNotMatch(text, /^(?:-[\d.]+|NaN) w$/m, `lineWeight ${lineWeight}`);
      if (lineWeight <= 0) assert.ok(!text.includes('h\nS\n'), `lineWeight ${lineWeight} draws no outline`);
    }
  });

  for (const nanVertex of ['hole', 'outer'] as const) {
    it(`outlines what survives a non-finite ${nanVertex} vertex, unfilled, instead of aborting`, async () => {
      const text = await exportPdf({ nanVertex });
      assert.ok(!text.includes('f*'), 'no fill: it would paint the opening or the wall wrongly');
      assert.ok(text.includes('h\nS\n'), 'the surviving ring is stroked');
    });
  }

  it('draws the cut lines of an entity whose polygon drew nothing (#2119)', async () => {
    const text = await exportPdf({ nanVertex: 'all', cutLine: true });
    assert.match(text, /^[-\d. ]+ m\n[-\d. ]+ l\nS$/m, 'the cut edge reaches the PDF as a line');
  });
});

describe('handleExportSVG uses the same resolver', () => {
  it('fills a layered cut with its per-layer colour, as the canvas does', async () => {
    const svg = await exportFile('svg', {
      activePresetId: 'preset-3d-colors',
      entityColorMap: new Map([[7, [1, 0, 0, 1]]]),
      polygonColor: [0, 0, 1, 1],
    });
    assert.match(svg, /<path [^>]*fill="#0000ff"[^>]*data-entity-id="7"/);
    assert.doesNotMatch(svg, /fill="#ff0000"/);
  });
});

describe('pdfColor', () => {
  it('expands short hex, splits alpha, reads rgb()/rgba(), rejects the rest', () => {
    assert.deepEqual(pdfColor('#abc'), { hex: '#aabbcc', alpha: 1 });
    assert.deepEqual(pdfColor('#112233'), { hex: '#112233', alpha: 1 });
    assert.deepEqual(pdfColor('#112233ff'), { hex: '#112233', alpha: 1 });
    assert.deepEqual(pdfColor('#11223300'), { hex: '#112233', alpha: 0 });
    assert.deepEqual(pdfColor('#f008'), { hex: '#ff0000', alpha: 136 / 255 });
    assert.deepEqual(pdfColor(' rgba(255, 0, 0, 0.5) '), { hex: '#ff0000', alpha: 0.5 });
    assert.deepEqual(pdfColor('rgb(0,128,255)'), { hex: '#0080ff', alpha: 1 });
    assert.deepEqual(pdfColor('transparent'), { hex: '#000000', alpha: 0 });
    assert.deepEqual(pdfColor('NONE'), { hex: '#000000', alpha: 0 });
    assert.equal(pdfColor('red'), null);
    assert.equal(pdfColor('rgb(1.2.3,0,0)'), null);
    assert.equal(pdfColor('rgb(300,0,0)'), null);
    assert.equal(pdfColor('#12'), null);
    assert.equal(pdfColor(''), null);
  });
});
