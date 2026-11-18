/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9296: inspect the real hook download, including model/map coordinates.

import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GraphicOverrideEngine, parseDxf, DEFAULT_SECTION_CONFIG, type Drawing2D, type DxfEntity } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';
import { type ScanOutlineLayer } from '@/lib/scan-outline/scan-outline';
import useDrawingExport from './useDrawingExport.js';

const drawing: Drawing2D = {
  config: { ...DEFAULT_SECTION_CONFIG, plane: { axis: 'y', position: 0, flipped: false }, scale: 100 },
  lines: [], cutPolygons: [], projectionPolygons: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 30, y: 40 } },
  stats: {
    cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0,
    polygonCount: 0, totalTriangles: 0, processingTimeMs: 0,
  },
};

function Harness({ outline, show, onReady }: { outline: ScanOutlineLayer | null; show: boolean; onReady: (fn: () => void) => void }): null {
  const { handleExportDXF } = useDrawingExport({
    drawing,
    displayOptions: { showHiddenLines: true, scale: 100, showScanSection: show, scanSectionOpacity: 1, scanSectionIncludeInExport: true },
    sectionPlane: { axis: 'down', position: 0, flipped: false },
    activePresetId: null,
    entityColorMap: new Map(),
    overridesEnabled: false,
    overrideEngine: new GraphicOverrideEngine([]),
    measure2DResults: [{ id: 'dimension', start: { x: 0, y: 1.5 }, end: { x: 5, y: 1.5 }, distance: 5 }], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
    sheetEnabled: false, activeSheet: null, dxfUnderlays: [], ifcDataStore: null,
    coordinateInfo: { wasmRtcOffset: { x: 1000, y: 2000, z: 0 }, originShift: { x: 0, y: 0, z: 0 } } as never,
    scanSection: { points: [], outline },
  });
  onReady(handleExportDXF);
  return null;
}

/** Run the real export and parse the DXF bytes it hands to the download. */
async function exportDxf(outline: ScanOutlineLayer | null, show: boolean, dimensions2D: Dimension2D[] = []): Promise<DxfEntity[]> {
  useViewerStore.setState({ models: new Map(), dimensions2D, drawing2DPlane: { axis: 'down', position: 0, flipped: false } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let run: (() => void) | null = null;
  const originalCreate = URL.createObjectURL;
  let resolveBlob!: (blob: Blob) => void;
  const dxfBlob = new Promise<Blob>((resolve) => { resolveBlob = resolve; });
  URL.createObjectURL = function (obj: Blob | MediaSource): string {
    if (obj instanceof Blob && obj.type === 'application/dxf') resolveBlob(obj);
    return originalCreate.call(URL, obj);
  };
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness outline={outline} show={show} onReady={(fn) => { run = fn; }} />);
    });
    let blob: Blob | null = null;
    await act(async () => {
      run!();
      blob = await dxfBlob;
    });
    const bytes = new Uint8Array(await (blob as unknown as Blob).arrayBuffer());
    return parseDxf(new TextDecoder('windows-1252').decode(bytes)).entities;
  } finally {
    URL.createObjectURL = originalCreate;
    if (root) await act(async () => { (root as Root).unmount(); });
    container.remove();
  }
}

it('the downloaded DXF retains the Distance markup and matching text (#9296)', async () => {
  const entities = await exportDxf(null, false);
  const dimensions = entities.filter(e => e.layer === 'IFC-DIMENSIONS');
  const line = dimensions.find(e => e.kind === 'line' && e.x1 === 1000 && e.x2 === 1005);
  assert.ok(line && line.kind === 'line');
  assert.equal(line.y1, 1998.5);
  assert.equal(line.y2, 1998.5);
  const label = dimensions.find(e => e.kind === 'text');
  assert.ok(label && label.kind === 'text');
  assert.match(label.text, /^5(?:\.0+)? m$/);
  assert.equal(label.x, 1002.5);
});

it('exports Distance and explicit linear dimensions once each through the same writer (#10020, #10077)', async () => {
  const current: Dimension2D = { id: 'current', a: { x: 0, y: 0 }, b: { x: 2, y: 0 }, offset: 0.5, orientation: 'aligned',
    plane: { axis: 'down', position: 0, flipped: false } };
  const other: Dimension2D = { ...current, id: 'other', text: 'OTHER CUT', plane: { ...current.plane!, position: 10 } };
  const entities = (await exportDxf(null, false, [current, other])).filter(e => e.layer === 'IFC-DIMENSIONS');
  const labels = entities.filter(e => e.kind === 'text');
  assert.equal(labels.length, 2, 'one label per dimension, no duplicate or other-cut writer');
  assert.ok(labels.some(e => e.kind === 'text' && e.text === '2000'));
  assert.ok(labels.some(e => e.kind === 'text' && /^5(?:\.0+)? m$/.test(e.text)));
  assert.equal(entities.filter(e => e.kind === 'line').length, 8, 'five explicit segments and three Distance segments');
});
