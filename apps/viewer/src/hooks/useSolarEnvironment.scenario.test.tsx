/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scenario test for `useSolarEnvironment` (issue #2526's map-absolute
 * guard), through the REAL hook call site rather than the pure
 * `enuToViewerDirection` helper.
 *
 * Deep review of #2534 (2026-08-10, louistrue): "useSolarEnvironment.ts:
 * 108-110 — reverting `effectiveConversion?.xAxisAbscissa` to
 * `mapConversion?.xAxisAbscissa` fails no test." This file mounts the hook
 * itself and reads the direction it publishes to `solarSunDirection`,
 * asserting it matches the IDENTITY-axis rotation (the map-absolute guard
 * firing) rather than the authored 90-degree rotation.
 */

import '@/test/setup-dom.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { sunPosition, azimuthAltitudeToEnu } from '@ifc-lite/solar';

import { useViewerStore } from '@/store';
import { computeCesiumModelOrigin } from '@/lib/geo/cesium-bridge';
import { enuToViewerDirection } from '@/lib/geo/solar-direction';
import { useSolarEnvironment, type SolarEnvironmentGeoref } from './useSolarEnvironment.js';

// #2526 Vectorworks-style map-absolute anchor: geometry re-based right next
// to the declared (repeated) anchor, 90-degree authored rotation.
const mapConversion: MapConversion = {
  id: 1, sourceCRS: 0, targetCRS: 0,
  eastings: 312000, northings: 5996150, orthogonalHeight: 0,
  xAxisAbscissa: 0, xAxisOrdinate: 1, scale: 1,
};
const projectedCRS: ProjectedCRS = { id: 2, name: 'EPSG:25833', mapUnitScale: 1 };
const coordinateInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
  wasmRtcOffset: { x: 312000, y: 5996150, z: 10 },
};

async function mountHook(georef: SolarEnvironmentGeoref | null): Promise<Root> {
  function Harness(): null {
    useSolarEnvironment(georef);
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
  // computeCesiumModelOrigin resolves proj4 (EPSG lookup + async import)
  // before the hook's origin effect settles; flush past that.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  return root;
}

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

describe('useSolarEnvironment (real hook call site, #2534 review gap)', () => {
  it('publishes the sun direction rotated by the IDENTITY axis, not the authored 90deg rotation', async () => {
    const solarDateMs = Date.UTC(2026, 5, 21, 12, 0, 0); // fixed instant, no flakiness
    useViewerStore.setState({ solarEnabled: true, solarDateMs, cesiumEnabled: true });

    const root = await mountHook({ mapConversion, projectedCRS, coordinateInfo, lengthUnitScale: 1 });
    try {
      const published = useViewerStore.getState().solarSunDirection;
      assert.ok(published, 'the hook must publish a sun direction for an enabled solar study');

      // Independently reconstruct the origin (lat/lon/gamma) the SAME way
      // the hook's own effect does — `computeCesiumModelOrigin` already
      // neutralises internally, so this call is unaffected by the finding.
      const origin = await computeCesiumModelOrigin(mapConversion, projectedCRS, coordinateInfo, 1);
      assert.ok(origin, 'origin must resolve for this fixture');
      const date = new Date(solarDateMs);
      const sp = sunPosition(date, origin!.latitude, origin!.longitude);
      const enu = azimuthAltitudeToEnu(sp.azimuth, sp.altitude);

      const identityAxisDirection = enuToViewerDirection(enu, 1, 0, origin!.gamma);
      const authoredAxisDirection = enuToViewerDirection(enu, mapConversion.xAxisAbscissa!, mapConversion.xAxisOrdinate!, origin!.gamma);

      // The 90-degree authored rotation must NOT have been applied.
      const dist = (a: readonly number[], b: readonly number[]) =>
        Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      assert.ok(
        dist(published!, authoredAxisDirection) > 0.1,
        `published direction must not match the authored-rotation prediction: published=${published}, authored=${authoredAxisDirection}`,
      );
      assert.ok(
        dist(published!, identityAxisDirection) < 1e-6,
        `published direction must match the identity-axis (guard-neutralised) prediction: published=${published}, identity=${identityAxisDirection}`,
      );
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
});
