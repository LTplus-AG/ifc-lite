/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scaled (non-sheet) section PDF drew cut polygons as black outlines
 * only, while the SVG export of the same section was coloured. These tests
 * read the PDF the user would download and check the cut polygon is filled
 * with the colour the SVG export uses, holes included, and that override
 * stroke colours reach the outline.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GraphicOverrideEngine, type Drawing2D, type GraphicOverrideRule } from '@ifc-lite/drawing-2d';
import useDrawingExport from './useDrawingExport.js';
import { pdfColor } from './cutPolygonStyle.js';
import { useActivityJournal } from '@/lib/activity/activity-journal';

/** A 4x3 m wall cut with a 1x1 m opening. */
function buildDrawing(polygonColor?: [number, number, number, number]): Drawing2D {
  return {
    config: {
      plane: { axis: 'y', position: 0, flipped: false },
      projectionDepth: 10,
      includeHiddenLines: true,
      creaseAngle: 30,
      scale: 50,
    },
    lines: [],
    cutPolygons: [
      {
        polygon: {
          outer: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
          holes: [[{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }]],
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
}

function Harness({ options, onReady }: { options: ExportOptions; onReady: (fn: () => void) => void }): null {
  const { handleExportPDF } = useDrawingExport({
    drawing: buildDrawing(options.polygonColor),
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
  onReady(() => handleExportPDF());
  return null;
}

/** Run the real export and return the downloaded PDF as latin1 text. */
async function exportPdf(options: ExportOptions = {}): Promise<string> {
  useActivityJournal.setState({ jobs: [] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let exportFn: (() => void) | null = null;
  const originalCreate = URL.createObjectURL;
  let resolvePdf!: (blob: Blob) => void;
  const pdfBlob = new Promise<Blob>((resolve) => { resolvePdf = resolve; });
  URL.createObjectURL = function (obj: Blob | MediaSource): string {
    if (obj instanceof Blob && obj.type === 'application/pdf') resolvePdf(obj);
    return originalCreate.call(URL, obj);
  };
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness options={options} onReady={(fn) => { exportFn = fn; }} />);
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
    if (root) await act(async () => { (root as Root).unmount(); });
    container.remove();
  }
}

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

describe('pdfColor', () => {
  it('expands short hex, splits alpha, passes other values through', () => {
    assert.deepEqual(pdfColor('#abc'), { hex: '#aabbcc', alpha: 1 });
    assert.deepEqual(pdfColor('#112233'), { hex: '#112233', alpha: 1 });
    assert.deepEqual(pdfColor('#112233ff'), { hex: '#112233', alpha: 1 });
    assert.deepEqual(pdfColor('#11223300'), { hex: '#112233', alpha: 0 });
    assert.deepEqual(pdfColor('red'), { hex: 'red', alpha: 1 });
  });
});
