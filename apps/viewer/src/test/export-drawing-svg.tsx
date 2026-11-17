/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Runs the real `handleExportSVG` over a drawing and returns the SVG text it saved. */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GraphicOverrideEngine, type Drawing2D } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import useDrawingExport from '@/hooks/useDrawingExport.js';

function Harness({ drawing, overrideEngine, onReady }: {
  drawing: Drawing2D;
  overrideEngine: GraphicOverrideEngine;
  onReady: (fn: () => void) => void;
}): null {
  const { handleExportSVG } = useDrawingExport({
    drawing,
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
    overrideEngine,
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

/** Intercepts the `Blob` `downloadFile` hands to `URL.createObjectURL`. */
export async function exportDrawingSvg(
  drawing: Drawing2D,
  overrideEngine = new GraphicOverrideEngine([]),
): Promise<string> {
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
      root.render(<Harness drawing={drawing} overrideEngine={overrideEngine} onReady={(fn) => { exportFn = fn; }} />);
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
