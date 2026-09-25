/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The placement gizmo's HEIGHT handle on an IfcMapConversionScaled file with
 * Scale x FactorZ != 1 (#4675).
 *
 * The camera frame draws viewer Y at `height + scaleZ * y` (cesium-bridge.ts),
 * so one viewer unit of drag is scaleZ metres of OrthogonalHeight, and an
 * OrthogonalHeight change of h metres moves the model h / scaleZ viewer units.
 * The XY handle already divides by its axis scale; this mounts the real
 * component with a stub camera and checks the height handle does the same in
 * both directions.
 */

import '@/test/setup-dom.js';
import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';

import { setGlobalRendererRef } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { CesiumPlacementGizmo } from './CesiumPlacementGizmo.js';

const projectedCRS: ProjectedCRS = { id: 2, name: 'EPSG:2056', mapUnitScale: 1 };
// Metre project and map, Scale 1 x FactorZ 2: the effective vertical scale is 2.
const scaledConversion: MapConversion = {
  id: 1, sourceCRS: 0, targetCRS: 0,
  eastings: 2600000, northings: 1200000, orthogonalHeight: 400,
  xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1, factorZ: 2,
};
const coordinateInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
  hasLargeCoordinates: false,
};
const ANCHOR = { x: 5, z: 5 }; // the bounds' horizontal centre

/**
 * A 100x100 canvas whose camera maps world Y to screen Y 1:10 and whose ray at
 * buffer row `by` passes the anchor's vertical line at world Y `-by / 10`.
 * Records every world point the gizmo projects.
 */
function stubRenderer(projected: Array<{ x: number; y: number; z: number }>): Renderer {
  const canvas = {
    width: 100, height: 100, clientWidth: 100, clientHeight: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  const camera = {
    projectToScreen: (p: { x: number; y: number; z: number }) => {
      projected.push(p);
      return { x: 50, y: 50 - p.y * 10 };
    },
    unprojectToRay: (_bx: number, by: number) => ({
      origin: { x: ANCHOR.x + 10, y: -by / 10, z: ANCHOR.z },
      direction: { x: -1, y: 0, z: 0 },
    }),
  };
  return { getCamera: () => camera, getCanvas: () => canvas } as unknown as Renderer;
}

async function mount(): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CesiumPlacementGizmo
        modelId="m0"
        mapConversion={scaledConversion}
        baseMapConversion={scaledConversion}
        projectedCRS={projectedCRS}
        coordinateInfo={coordinateInfo}
        lengthUnitScale={1}
      />,
    );
  });
  return { root, container };
}

async function unmount({ root, container }: { root: Root; container: HTMLDivElement }) {
  await act(async () => { root.unmount(); });
  container.remove();
}

const draftAt = (orthogonalHeight: number) => ({
  eastings: scaledConversion.eastings,
  northings: scaledConversion.northings,
  orthogonalHeight,
  xAxisAbscissa: 1,
  xAxisOrdinate: 0,
});

// The gizmo re-projects on every animation frame; one projection per effect
// run is all these checks read, and a live loop never lets the test settle.
const originalRaf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = () => 0;

const originalState = useViewerStore.getState();
after(() => {
  useViewerStore.setState(originalState, true);
  globalThis.requestAnimationFrame = originalRaf;
});
afterEach(() => { setGlobalRendererRef({ current: null }); });

describe('CesiumPlacementGizmo height handle with Scale x FactorZ (#4675)', () => {
  it('writes a viewer-Y drag into OrthogonalHeight through the vertical scale', async () => {
    setGlobalRendererRef({ current: stubRenderer([]) });
    useViewerStore.setState({
      cesiumPlacementEditMode: true,
      cesiumPlacementDraftModelId: 'm0',
      cesiumPlacementDraft: draftAt(400),
    });
    const mounted = await mount();
    try {
      const handle = mounted.container.querySelector('[aria-label="Drag OrthogonalHeight"]');
      assert.ok(handle, 'the height handle renders once the stub camera projects the gizmo');
      const pointer = (type: string, clientY: number) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, clientX: 50, clientY,
      });
      await act(async () => { handle.dispatchEvent(pointer('pointerdown', 50)); }); // world Y -5
      await act(async () => { handle.dispatchEvent(pointer('pointermove', 30)); }); // world Y -3
      // 2 viewer units up x scaleZ 2 = 4 m of OrthogonalHeight. Unscaled: 402.
      assert.equal(useViewerStore.getState().cesiumPlacementDraft?.orthogonalHeight, 404);
    } finally {
      await unmount(mounted);
    }
  });

  it('previews an OrthogonalHeight change at height / scaleZ in viewer units', async () => {
    const anchorY = async (orthogonalHeight: number) => {
      const projected: Array<{ x: number; y: number; z: number }> = [];
      setGlobalRendererRef({ current: stubRenderer(projected) });
      useViewerStore.setState({
        cesiumPlacementEditMode: true,
        cesiumPlacementDraftModelId: 'm0',
        cesiumPlacementDraft: draftAt(orthogonalHeight),
      });
      const mounted = await mount();
      await unmount(mounted);
      // The first point each frame projects is the gizmo centre, `anchorWorld`.
      assert.ok(projected.length > 0);
      return projected[0].y;
    };
    // 4 m higher is 2 viewer units under scaleZ 2. Unscaled: 4.
    assert.equal((await anchorY(404)) - (await anchorY(400)), 2);
  });
});
