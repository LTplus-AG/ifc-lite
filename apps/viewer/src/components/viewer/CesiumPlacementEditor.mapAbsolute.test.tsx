/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scenario test for `CesiumPlacementEditor`'s map-absolute UI guard
 * (issue #2526's guard, #2534 review finding).
 *
 * Deep review of #2534 (2026-08-10, louistrue) — blocking issue on
 * CesiumPlacementEditor.tsx:507-530: "On a map-absolute file the placement
 * gizmo becomes a silent no-op inside the 10km window ... Disclosed only in
 * a source comment; no UI guard, no test." Also: "the cesium-placement.test.
 * ts cases exercise the new helper functions directly, not the component
 * that decides what to pass them" and "CesiumPlacementEditor.tsx — both
 * `...ForGeometry` swaps ... are untested."
 *
 * This file mounts the REAL component (not the pure helpers) with a
 * map-absolute fixture and asserts the warning banner it now renders
 * (`data-testid="cesium-placement-map-absolute-warning"`) appears — and
 * does NOT appear for a compliant file. It also exercises the
 * `guardConversion` fix: the banner must track the DRAFT anchor (not just
 * the frozen session baseline), reproducing the "second drag disagrees with
 * the preview" scenario the review described.
 */

import '@/test/setup-dom.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';

import { useViewerStore } from '@/store';
import { CesiumPlacementEditor } from './CesiumPlacementEditor.js';

const projectedCRS: ProjectedCRS = { id: 2, name: 'EPSG:25833', mapUnitScale: 1 };

// #2526 Vectorworks-style map-absolute anchor: geometry re-based right next
// to the declared (repeated) anchor — inside the 10km detection window.
const mapAbsoluteConversion: MapConversion = {
  id: 1, sourceCRS: 0, targetCRS: 0,
  eastings: 312000, northings: 5996150, orthogonalHeight: 0,
  xAxisAbscissa: 0, xAxisOrdinate: 1, scale: 1,
};
const mapAbsoluteCoordinateInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
  wasmRtcOffset: { x: 312000, y: 5996150, z: 10 },
};

// Compliant file: declared anchor far from LOCAL geometry (near-zero bounds).
const compliantConversion: MapConversion = {
  id: 2, sourceCRS: 0, targetCRS: 0,
  eastings: 5000, northings: 3000, orthogonalHeight: 0,
  xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
};
const compliantCoordinateInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
  hasLargeCoordinates: false,
};

async function mount(props: {
  mapConversion: MapConversion;
  baseMapConversion: MapConversion;
  coordinateInfo: CoordinateInfo;
}): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CesiumPlacementEditor
        modelId="m0"
        mapConversion={props.mapConversion}
        baseMapConversion={props.baseMapConversion}
        projectedCRS={projectedCRS}
        coordinateInfo={props.coordinateInfo}
        lengthUnitScale={1}
      />,
    );
  });
  return { root, container };
}

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

describe('CesiumPlacementEditor — map-absolute UI guard (#2534 review)', () => {
  it('shows the map-absolute warning banner for a map-absolute file', async () => {
    useViewerStore.setState({
      cesiumPlacementEditMode: true,
      cesiumPlacementDraftModelId: null,
      cesiumPlacementDraft: null,
    });
    const { root, container } = await mount({
      mapConversion: mapAbsoluteConversion,
      baseMapConversion: mapAbsoluteConversion,
      coordinateInfo: mapAbsoluteCoordinateInfo,
    });
    try {
      const banner = container.querySelector('[data-testid="cesium-placement-map-absolute-warning"]');
      assert.ok(banner, 'expected the map-absolute warning banner to render');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('does NOT show the warning banner for a compliant file', async () => {
    useViewerStore.setState({
      cesiumPlacementEditMode: true,
      cesiumPlacementDraftModelId: null,
      cesiumPlacementDraft: null,
    });
    const { root, container } = await mount({
      mapConversion: compliantConversion,
      baseMapConversion: compliantConversion,
      coordinateInfo: compliantCoordinateInfo,
    });
    try {
      const banner = container.querySelector('[data-testid="cesium-placement-map-absolute-warning"]');
      assert.strictEqual(banner, null, 'compliant files must not show the map-absolute banner');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('tracks a live draft anchor: the banner reflects the CURRENT draft, not just the frozen session baseline', async () => {
    // Reproduces the review's "second drag disagrees with the preview"
    // scenario: an in-progress draft has already moved the anchor OUT of
    // the map-absolute window (a nudge past 10km), while baseMapConversion
    // (the session's original, still map-absolute) stays put. The guard
    // must react to the CURRENT draft, not the stale baseline — proving
    // `guardConversion = { ...baseMapConversion, ...activeDraft }` is wired
    // through to the banner, not just `baseMapConversion` alone.
    useViewerStore.setState({
      cesiumPlacementEditMode: true,
      cesiumPlacementDraftModelId: 'm0',
      cesiumPlacementDraft: {
        eastings: mapAbsoluteConversion.eastings + 50_000, // far outside the 10km window
        northings: mapAbsoluteConversion.northings,
        orthogonalHeight: 0,
        xAxisAbscissa: 0,
        xAxisOrdinate: 1,
      },
    });
    const { root, container } = await mount({
      mapConversion: mapAbsoluteConversion,
      baseMapConversion: mapAbsoluteConversion,
      coordinateInfo: mapAbsoluteCoordinateInfo,
    });
    try {
      const banner = container.querySelector('[data-testid="cesium-placement-map-absolute-warning"]');
      assert.strictEqual(banner, null, 'the banner must clear once the live draft anchor has left the detection window');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
