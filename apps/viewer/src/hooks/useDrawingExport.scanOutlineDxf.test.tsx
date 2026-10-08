/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The drawing panel's real DXF download (`handleExportDXF`) carries the
 * traced scan outline (#6871): a SCAN-OUTLINE layer with one closed polyline
 * per ring when the scan layer is shown, mapped by the same plan-section
 * transform as the cut, and nothing when the scan layer is hidden. The rings
 * come from the real wasm trace of a seeded room slab.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GraphicOverrideEngine, parseDxf, DEFAULT_SECTION_CONFIG, type Drawing2D, type DxfEntity } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { ensureWasm, roomSlab } from '@/test/scan-slab-fixture';
import { traceScanOutlineLayer, type ScanOutlineLayer } from '@/lib/scan-outline/scan-outline';
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

function Harness({ outline, show, onReady }: { outline: ScanOutlineLayer; show: boolean; onReady: (fn: () => void) => void }): null {
  const { handleExportDXF } = useDrawingExport({
    drawing,
    displayOptions: { showHiddenLines: true, scale: 100, showScanSection: show, scanSectionOpacity: 1, scanSectionIncludeInExport: true },
    sectionPlane: { axis: 'down', position: 0, flipped: false },
    activePresetId: null,
    entityColorMap: new Map(),
    overridesEnabled: false,
    overrideEngine: new GraphicOverrideEngine([]),
    measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
    sheetEnabled: false, activeSheet: null, dxfUnderlays: [], ifcDataStore: null,
    coordinateInfo: { wasmRtcOffset: { x: 1000, y: 2000, z: 0 }, originShift: { x: 0, y: 0, z: 0 } } as never,
    scanSection: { points: [], outline },
  });
  onReady(handleExportDXF);
  return null;
}

/** Run the real export and parse the DXF bytes it hands to the download. */
async function exportDxf(outline: ScanOutlineLayer, show: boolean): Promise<DxfEntity[]> {
  useViewerStore.setState({ models: new Map() });
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

describe('useDrawingExport DXF carries the scan outline (#6871)', () => {
  it('writes every ring on SCAN-OUTLINE at world coordinates while the scan layer is shown', async (t) => {
    if (!ensureWasm(t)) return;
    const outline = traceScanOutlineLayer(roomSlab(), 0.3);
    const entities = await exportDxf(outline, true);
    const polys = entities.filter((e): e is Extract<DxfEntity, { kind: 'polyline' }> => e.kind === 'polyline' && e.layer === 'SCAN-OUTLINE');
    assert.equal(polys.length, outline.rings.length);
    assert.equal(polys.length, 2);
    // Plan section, unflipped: world_x = x + 1000, world_y = 2000 - y.
    polys.forEach((poly, r) => {
      assert.equal(poly.closed, true);
      poly.vertices.forEach((v, k) => {
        const p = outline.rings[r][k];
        assert.ok(Math.abs(v.x - (p.x + 1000)) < 1e-6 && Math.abs(v.y - (2000 - p.y)) < 1e-6, `ring ${r} vertex ${k}`);
      });
    });
  });

  it('leaves the outline out when the scan layer is hidden', async (t) => {
    if (!ensureWasm(t)) return;
    const outline = traceScanOutlineLayer(roomSlab(), 0.3);
    const entities = await exportDxf(outline, false);
    assert.equal(entities.filter((e) => e.layer === 'SCAN-OUTLINE').length, 0);
  });
});
