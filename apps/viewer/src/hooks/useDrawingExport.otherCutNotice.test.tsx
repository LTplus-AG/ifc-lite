/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SVG export and Print have no omission dialog, unlike PDF and DXF, so they
 * tell the user with a notice when they leave out dimensions drawn on
 * another cut. The observation is the info toast each real handler raises.
 *
 * MUTATION TARGETS: drop the `noticeOtherCutDimensionsLeftOut` call from
 * `handleExportSVG` or `handlePrint` in `useDrawingExport.ts`, or its
 * `count > 0` guard in `useExportDimensions.ts`.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GraphicOverrideEngine, DEFAULT_SECTION_CONFIG, type Drawing2D } from '@ifc-lite/drawing-2d';
import { toast } from '@/components/ui/toast';
import { resolve } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';
import useDrawingExport from './useDrawingExport.js';

const plane = { axis: 'down' as const, position: 50, flipped: false };
const onCut: Dimension2D = { id: 'on', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: 0.5, orientation: 'aligned', plane };
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

type Handlers = ReturnType<typeof useDrawingExport>;

function Harness({ onReady }: { onReady: (h: Handlers) => void }): null {
  const handlers = useDrawingExport({
    drawing,
    displayOptions: { showHiddenLines: true, scale: 50, showScanSection: false, scanSectionOpacity: 0, scanSectionIncludeInExport: false },
    sectionPlane: plane,
    activePresetId: null, entityColorMap: new Map(), overridesEnabled: false, overrideEngine: new GraphicOverrideEngine([]),
    measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
    sheetEnabled: false, activeSheet: null,
    dxfUnderlays: [], ifcDataStore: null, coordinateInfo: undefined, scanSection: { points: [] },
  });
  onReady(handlers);
  return null;
}

/** Run one real handler and return the info notices it raised. */
async function noticesFrom(run: (h: Handlers) => void): Promise<string[]> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let handlers: Handlers | null = null;
  const notes: string[] = [];
  const realInfo = toast.info;
  const realOpen = window.open;
  const realCreate = URL.createObjectURL;
  (toast as { info: (m: string) => void }).info = (m) => { notes.push(m); };
  // Print writes into a popup; a stand-in document is enough.
  window.open = (() => ({ document: { write: () => {}, close: () => {} } })) as unknown as typeof window.open;
  URL.createObjectURL = () => 'blob:stub';
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness onReady={(h) => { handlers = h; }} />);
    });
    await act(async () => { run(handlers!); });
    return notes;
  } finally {
    Object.assign(toast, { info: realInfo });
    window.open = realOpen;
    URL.createObjectURL = realCreate;
    if (root) await act(async () => { (root as Root).unmount(); });
    container.remove();
  }
}

const expected = resolve('section2d.export.otherCutDimensionsLeftOut', { count: 1 });

describe('SVG export and Print notice other-cut dimensions they leave out', () => {
  afterEach(() => {
    useViewerStore.setState({ dimensions2D: [], drawing2DPlane: null });
  });

  describe('one dimension on the current cut, one on another cut', () => {
    beforeEach(() => {
      useViewerStore.setState({ models: new Map(), dimensions2D: [onCut, otherCut], drawing2DPlane: plane, unitDisplayOverrides: {} });
    });

    it('the English notice states the count', () => {
      assert.match(expected, /^1 dimension drawn on another cut/);
    });

    it('SVG export notices one left-out dimension', async () => {
      assert.deepEqual(await noticesFrom((h) => h.handleExportSVG()), [expected]);
    });

    it('Print notices one left-out dimension', async () => {
      assert.deepEqual(await noticesFrom((h) => h.handlePrint()), [expected]);
    });
  });

  describe('no dimension on another cut', () => {
    beforeEach(() => {
      useViewerStore.setState({ models: new Map(), dimensions2D: [onCut], drawing2DPlane: plane, unitDisplayOverrides: {} });
    });

    it('SVG export raises no notice', async () => {
      assert.deepEqual(await noticesFrom((h) => h.handleExportSVG()), []);
    });

    it('Print raises no notice', async () => {
      assert.deepEqual(await noticesFrom((h) => h.handlePrint()), []);
    });
  });
});
