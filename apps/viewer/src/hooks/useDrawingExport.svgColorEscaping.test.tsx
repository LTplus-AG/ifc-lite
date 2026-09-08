/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `fillColor`/`strokeColor` on a graphic-override rule reach the SVG writer
 * through a free-text `<Input>` in `DrawingSettingsPanel.tsx` (the color
 * swatch next to it is `type="color"` and constrained to `#rrggbb`, but the
 * text field beside it accepts anything). `generateExportSVG` and
 * `generateSheetSVG` in `useDrawingExport.ts` both interpolated
 * `result.style.fillColor`/`result.style.strokeColor` straight into a
 * `fill="…"`/`stroke="…"` attribute with no escaping — every other
 * user-derived string reaching this writer (ifcType, annotation text, DXF
 * layer names) goes through the local `escapeXml`, these two did not.
 *
 * A value containing `"` closes the attribute early; the rest of the string
 * is then parsed as markup, so a rule whose fill color reads
 * `x" fill="red"/><script>...</script><path d="` turns the exported SVG
 * into a document that is not well-formed XML and that a browser opening
 * the file directly will execute as a live `<script>` element — the same
 * class of bug the SVG-writer lens calls out as the top-ranked failure mode
 * (an unescaped metacharacter making the file fail to parse at all), here
 * additionally armed as script injection because the metacharacter reaches
 * an attribute value rather than text content.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  GraphicOverrideEngine,
  ifcTypeCriterion,
  type Drawing2D,
  type GraphicOverrideRule,
} from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import useDrawingExport from './useDrawingExport.js';

const WALL_ID = 1;

// A `"` breaks out of the attribute; the rest is markup. On unescaped
// output this both makes the document non-well-formed AND parses to a real
// `<script>` element (proven below via the DOM the browser would build).
const XSS_PAYLOAD = 'x" fill="red"/><script>window.__pwned = true</script><path d="M0 0';

function box(x0: number, x1: number): { x: number; y: number }[] {
  return [
    { x: x0, y: 0 },
    { x: x1, y: 0 },
    { x: x1, y: 1 },
    { x: x0, y: 1 },
  ];
}

function buildDrawing(): Drawing2D {
  return {
    config: {
      plane: { axis: 'z', position: 0, flipped: false },
      projectionDepth: 10,
      includeHiddenLines: true,
      creaseAngle: 30,
      scale: 50,
    },
    lines: [],
    cutPolygons: [
      {
        polygon: { outer: box(0, 4), holes: [] },
        entityId: WALL_ID,
        ifcType: 'IfcWall',
        modelIndex: 0,
        isCut: true,
      },
    ],
    projectionPolygons: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: 4, y: 1 } },
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

function maliciousRules(): GraphicOverrideRule[] {
  return [
    {
      id: 'xss',
      name: 'Malicious style',
      enabled: true,
      priority: 100,
      criteria: ifcTypeCriterion(['IfcWall']),
      style: { fillColor: XSS_PAYLOAD, strokeColor: XSS_PAYLOAD },
    },
  ];
}

interface HarnessProps {
  onReady: (fn: () => void) => void;
}

function Harness({ onReady }: HarnessProps): null {
  const { handleExportSVG } = useDrawingExport({
    drawing: buildDrawing(),
    displayOptions: {
      showHiddenLines: true,
      scale: 50,
      showScanSection: false,
      scanSectionOpacity: 0,
      scanSectionIncludeInExport: false,
    },
    sectionPlane: { axis: 'down', position: 0, flipped: false },
    activePresetId: null,
    entityColorMap: new Map(),
    overridesEnabled: true,
    overrideEngine: new GraphicOverrideEngine(maliciousRules()),
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
  onReady(handleExportSVG);
  return null;
}

/** Runs the real `handleExportSVG` and returns the SVG text it produced, by
 *  intercepting the `Blob` `downloadFile` hands to `URL.createObjectURL`. */
async function exportSvg(): Promise<string> {
  useViewerStore.setState({ models: new Map() });
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let exportFn: (() => void) | null = null;

  const originalCreate = URL.createObjectURL;
  let resolveSvg!: (blob: Blob) => void;
  const svgBlob = new Promise<Blob>((resolve) => {
    resolveSvg = resolve;
  });
  URL.createObjectURL = function (obj: Blob | MediaSource): string {
    if (obj instanceof Blob && obj.type === 'image/svg+xml') resolveSvg(obj);
    return originalCreate.call(URL, obj);
  };

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness onReady={(fn) => { exportFn = fn; }} />);
    });
    let blob: Blob | null = null;
    await act(async () => {
      exportFn!();
      blob = await svgBlob;
    });
    return await (blob as unknown as Blob).text();
  } finally {
    URL.createObjectURL = originalCreate;
    if (root) await act(async () => { (root as Root).unmount(); });
    container.remove();
  }
}

describe('useDrawingExport SVG writer — override-rule colors are XML-escaped', () => {
  it('a rule whose fillColor/strokeColor carries an XML metacharacter still produces well-formed, script-free SVG', async () => {
    const svg = await exportSvg();

    // Strict parse: a real browser opening the file would build this same
    // DOM. A `parsererror` node means the file is not well-formed XML.
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    assert.equal(
      doc.querySelector('parsererror'),
      null,
      `exported SVG is not well-formed XML:\n${svg}`,
    );

    // Even short of a hard parse failure, the payload must never turn into
    // a live element — proves the `"` did not break out of the attribute.
    assert.equal(
      doc.querySelectorAll('script').length,
      0,
      'an override rule color must never inject a <script> element into the exported SVG',
    );

    // The raw unescaped payload must not appear verbatim in the markup.
    assert.ok(
      !svg.includes(XSS_PAYLOAD),
      'the fillColor/strokeColor payload must be XML-escaped, not interpolated verbatim',
    );
  });

  it('CONTROL: a plain hex-color rule still exports valid, parseable SVG', async () => {
    useViewerStore.setState({ models: new Map() });
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    let exportFn: (() => void) | null = null;
    const originalCreate = URL.createObjectURL;
    let resolveSvg!: (blob: Blob) => void;
    const svgBlob = new Promise<Blob>((resolve) => { resolveSvg = resolve; });
    URL.createObjectURL = function (obj: Blob | MediaSource): string {
      if (obj instanceof Blob && obj.type === 'image/svg+xml') resolveSvg(obj);
      return originalCreate.call(URL, obj);
    };

    function ControlHarness({ onReady }: HarnessProps): null {
      const { handleExportSVG } = useDrawingExport({
        drawing: buildDrawing(),
        displayOptions: {
          showHiddenLines: true,
          scale: 50,
          showScanSection: false,
          scanSectionOpacity: 0,
          scanSectionIncludeInExport: false,
        },
        sectionPlane: { axis: 'down', position: 0, flipped: false },
        activePresetId: null,
        entityColorMap: new Map(),
        overridesEnabled: true,
        overrideEngine: new GraphicOverrideEngine([
          {
            id: 'plain',
            name: 'Plain style',
            enabled: true,
            priority: 100,
            criteria: ifcTypeCriterion(['IfcWall']),
            style: { fillColor: '#BBDEFB', strokeColor: '#000000' },
          },
        ]),
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
      onReady(handleExportSVG);
      return null;
    }

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(<ControlHarness onReady={(fn) => { exportFn = fn; }} />);
      });
      let blob: Blob | null = null;
      await act(async () => {
        exportFn!();
        blob = await svgBlob;
      });
      const svg = await (blob as unknown as Blob).text();
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      assert.equal(doc.querySelector('parsererror'), null, 'a plain hex-color rule must still export well-formed SVG');
      assert.ok(svg.includes('#BBDEFB'), 'the plain color must still reach the output');
    } finally {
      URL.createObjectURL = originalCreate;
      if (root) await act(async () => { (root as Root).unmount(); });
      container.remove();
    }
  });
});
