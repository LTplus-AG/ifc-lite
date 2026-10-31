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
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { waitFor } from '@/test/render.js';

/** Outer rings that enclose no area, so they are lines rather than polygons. */
const LINE_OUTERS = {
  'two-point': [{ x: 0, y: 3 }, { x: 4, y: 3 }],
  collinear: [{ x: 0, y: 3 }, { x: 2, y: 3 }, { x: 4, y: 3 }],
  // Shoelace rounding leaves ~1e-17 here, not 0.
  diagonal: [{ x: 0.1, y: 0.3 }, { x: 0.2, y: 0.6 }, { x: 0.3, y: 0.9 }],
  // LV95-scale coordinates: raw shoelace products leave 4.9e-4 here.
  lv95: [
    { x: 2602726.986, y: 1210018.744 }, { x: 2602730.686, y: 1210021.054 },
    { x: 2602734.386, y: 1210023.364 }, { x: 2602738.086, y: 1210025.674 },
  ],
};

/** A 4x3 m wall cut with a 1x1 m opening. */
function buildDrawing({ polygonColor, noOuter = false, nanVertex, cutLine = false, twoWalls = false, lineOuter, lv95Wall = false }: ExportOptions = {}): Drawing2D {
  const at = (ring: 'hole' | 'outer', v: number) => (nanVertex === ring || nanVertex === 'all' ? Number.NaN : v);
  const shift = (ring: { x: number; y: number }[]) => (lv95Wall ? ring.map((p) => ({ x: p.x + 2600000, y: p.y + 1200000 })) : ring);
  const wall: Drawing2D['cutPolygons'][number] = {
    polygon: {
      outer: noOuter ? [] : lineOuter ? LINE_OUTERS[lineOuter] : shift([{ x: 0, y: 0 }, { x: at('outer', 4), y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]),
      holes: [shift([{ x: 1, y: 1 }, { x: at('hole', 2), y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }])],
    },
    ifcType: 'IfcWall',
    entityId: 7,
    modelIndex: 0,
    isCut: true,
    ...(polygonColor ? { color: polygonColor } : {}),
  };
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
    cutPolygons: twoWalls ? [wall, { ...wall, entityId: 8 }] : [wall],
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
  /** The outer ring encloses no area: two points, or three collinear ones. */
  lineOuter?: keyof typeof LINE_OUTERS;
  /** Shift the wall to LV95-scale coordinates. */
  lv95Wall?: boolean;
  /** A second, identical wall polygon. */
  twoWalls?: boolean;
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
function colorOps(text: string, kind: 'fill' | 'stroke'): number[][] {
  const [rgb, grey] = kind === 'fill' ? ['rg', 'g'] : ['RG', 'G'];
  const num = '(\\d+\\.?\\d*|\\.\\d+)';
  const ops = new RegExp(`^(?:${num} ${num} ${num} ${rgb}|${num} ${grey})$`, 'gm');
  return [...text.matchAll(ops)].map((m) => (m[4] !== undefined ? [m[4], m[4], m[4]] : [m[1], m[2], m[3]]).map(parseFloat));
}
const isColor = (got: number[], hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].every((v, i) => Math.abs(got[i] - v / 255) <= 0.006);
};
function setsColor(text: string, kind: 'fill' | 'stroke', hex: string): boolean {
  return colorOps(text, kind).some((got) => isColor(got, hex));
}
/** The stroke colour in force for the first cut-polygon outline, if one is drawn. */
function outlineStrokeColor(text: string): number[] | undefined {
  const outline = text.indexOf('h\nS\n');
  return outline < 0 ? undefined : colorOps(text.slice(0, outline), 'stroke').at(-1);
}

/** A lone stroked segment: how `drawing.lines` (including cut lines) are written. */
const CUT_LINE = /^[-\d. ]+ m\n[-\d. ]+ l\nS$/m;

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

  it('matches the SVG export under default settings (3D colours preset, overrides on, no rules)', async () => {
    const text = await exportPdf({
      activePresetId: 'preset-3d-colors',
      entityColorMap: new Map([[7, [0, 0.5, 0, 1]]]),
      overrideRules: [],
    });
    assert.ok(setsColor(text, 'fill', '#008000'), 'material fill');
    assert.match(text, /^0\.70\d* w$/m, 'the engine default 0.25 mm outline (0.71 pt), as in the SVG export');
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

});

describe('handleExportPDF (non-sheet) edge cases', () => {
  it('falls back to the type colour and black for colours jsPDF cannot take', async () => {
    const text = await exportPdf({ overrideRules: [wallRule({ fillColor: '#12', strokeColor: 'bogus' })] });
    assert.ok(setsColor(text, 'fill', '#b0b0b0'), 'unfinished #12 fill falls back to the IfcWall colour');
    // The colour in force for the outline, not any black elsewhere in the stream.
    const stroke = outlineStrokeColor(text);
    assert.ok(stroke && isColor(stroke, '#000000'), 'unparseable stroke falls back to black');
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
    assert.ok(setsColor(text, 'stroke', '#1976d2'), 'stroke colour without its alpha byte');
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

  for (const nanVertex of ['outer', 'hole', 'all'] as const) {
    it(`draws the cut lines of an entity whose rings were not all drawn (${nanVertex}, #2119)`, async () => {
      const text = await exportPdf({ nanVertex, cutLine: true });
      assert.match(text, CUT_LINE, 'the cut edge reaches the PDF as a line');
    });
  }

  for (const lineOuter of Object.keys(LINE_OUTERS) as (keyof typeof LINE_OUTERS)[]) {
    it(`keeps the cut lines of an entity whose outer ring encloses no area (${lineOuter}, #8464)`, async () => {
      const text = await exportPdf({ lineOuter, cutLine: true });
      assert.match(text, CUT_LINE, 'a ring without area is not a polygon, so its cut edge stays');
      assert.ok(!text.includes('f*'), 'nothing is filled');
      assert.ok(text.includes('h\nS\n'), 'the surviving rings are still outlined');
    });
  }

  it('still fills a real wall at LV95-scale coordinates (#8464)', async () => {
    const text = await exportPdf({ lv95Wall: true });
    assert.ok(text.includes('f*'), 'the zero-area check must not reject a real polygon far from the origin');
  });

  it('still skips cut lines for an entity whose outer ring is drawn', async () => {
    const text = await exportPdf({ cutLine: true });
    assert.doesNotMatch(text, CUT_LINE);
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

// #8464. Tested through the export rather than by importing pdf-color: CI's revert
// check deletes files the PR adds, and this test must still load. Every rule
// also sets a stroke colour, so a fallback fill is told apart from an
// override that was never applied.
describe('override colour forms in the PDF', () => {
  const cases: { fillColor: string; fill: string | null; opacity?: RegExp }[] = [
    { fillColor: '#abc', fill: '#aabbcc' },
    { fillColor: '#00FF0080', fill: '#00ff00', opacity: /\/ca 0\.5\b/ },
    { fillColor: '#f008', fill: '#ff0000', opacity: /\/ca 0\.53\b/ },
    { fillColor: ' RGBA(255, 0, 0, 0.5) ', fill: '#ff0000', opacity: /\/ca 0\.5\b/ },
    { fillColor: 'rgb(0,128,255)', fill: '#0080ff' },
    { fillColor: '#11223300', fill: null },
    // Invalid CSS falls back to the IfcWall colour (jsPDF would read 'bad'
    // as #bbaadd). Valid names are covered by the canvas test at the end.
    { fillColor: 'bad', fill: '#b0b0b0' },
    { fillColor: 'rgb(1.2.3,0,0)', fill: '#b0b0b0' },
  ];
  for (const { fillColor, fill, opacity } of cases) {
    it(`${JSON.stringify(fillColor)} ${fill ? `fills ${fill}` : 'is not filled'}`, async () => {
      const text = await exportPdf({ overrideRules: [wallRule({ fillColor, strokeColor: '#1976D2' })] });
      assert.ok(setsColor(text, 'stroke', '#1976d2'), 'the override was applied');
      if (fill) assert.ok(setsColor(text, 'fill', fill), `fill ${fill}`);
      else assert.ok(!text.includes('f*'), 'zero alpha draws no fill');
      if (opacity) assert.match(text, opacity);
    });
  }
});

describe('CSS colours resolved by the browser canvas (#8464)', () => {
  it('uses the canvas-normalised colour for names, hsl() and space syntax; warns once per bad colour', async () => {
    // happy-dom has no 2D canvas. This stub normalises like a browser does
    // and ignores invalid values, so it checks the wiring and the
    // invalid-value detection, not a real browser's colour parser.
    const known: Record<string, string> = {
      navy: '#000080',
      'hsl(120, 100%, 25%)': '#008000',
      'rgb(255 0 0 / 50%)': 'rgba(255, 0, 0, 0.5)',
    };
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error -- test stub, narrower than the DOM lib's overloads
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type !== '2d') return null;
      let style = '#000000';
      return {
        get fillStyle() { return style; },
        set fillStyle(v: string) { if (/^#[0-9a-f]{6}$/.test(v)) style = v; else if (known[v]) style = known[v]; },
      };
    };
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      for (const [fillColor, fill, opacity] of [
        ['hsl(120, 100%, 25%)', '#008000', null],
        ['rgb(255 0 0 / 50%)', '#ff0000', /\/ca 0\.5\b/],
      ] as const) {
        const text = await exportPdf({ overrideRules: [wallRule({ fillColor, strokeColor: 'navy' })] });
        assert.ok(setsColor(text, 'fill', fill), fillColor);
        assert.ok(setsColor(text, 'stroke', '#000080'), 'named stroke');
        if (opacity) assert.match(text, opacity);
      }
      warnings.length = 0;
      const text = await exportPdf({ twoWalls: true, overrideRules: [wallRule({ fillColor: 'bogus' })] });
      assert.ok(setsColor(text, 'fill', '#b0b0b0'), 'an invalid name still falls back');
      assert.equal(warnings.length, 1, 'two polygons with the same bad colour warn once');
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      console.warn = originalWarn;
    }
  });
});
