/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { cleanup, render, waitFor } from '@/test/render.js';
import { computeFootprintGeoJSON } from '@/lib/geo/reproject.js';
import { useLocationGeoreference } from './use-location-georeference.js';

interface Inputs {
  conversion?: MapConversion;
  crs?: ProjectedCRS;
  coordinateInfo?: CoordinateInfo;
  lengthUnitScale?: number;
}

function harness(initial: Inputs) {
  let change: (next: Inputs) => void = () => { throw new Error('Harness not mounted'); };
  function Probe() {
    const [inputs, setInputs] = useState(initial);
    change = setInputs;
    const state = useLocationGeoreference(inputs.conversion, inputs.crs, inputs.coordinateInfo, inputs.lengthUnitScale ?? 1);
    return <output>{JSON.stringify(state)}</output>;
  }
  const ui = render(<Probe />);
  return {
    read: () => JSON.parse(ui.textContent ?? '{}') as ReturnType<typeof useLocationGeoreference>,
    update: (next: Inputs) => act(() => change(next)),
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const swiss: Inputs = {
  conversion: { id: 60, sourceCRS: 59, targetCRS: 61, eastings: 2619073.0368, northings: 1263523.6017, orthogonalHeight: 0 },
  crs: { id: 61, name: 'EPSG:2056', mapUnitScale: 1 },
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    hasLargeCoordinates: false,
    wasmRtcOffset: { x: -2619073, y: -1263523, z: 0 },
  },
};

it('#6677 a pending old model cannot replace the latest origin or its ready state', async () => {
  let release!: (response: Response) => void;
  let requested = false;
  const response = new Promise<Response>(resolve => { release = resolve; });
  globalThis.fetch = async input => {
    assert.equal(String(input), 'https://epsg.io/9996677.proj4');
    requested = true;
    return response;
  };
  const probe = harness({
    conversion: { id: 1, sourceCRS: 0, targetCRS: 2, eastings: 7, northings: 47, orthogonalHeight: 0 },
    crs: { id: 2, name: 'EPSG:9996677' },
  });
  await waitFor(() => requested, 'old projection lookup started');
  assert.equal(probe.read().mapState, 'loading');
  probe.update({
    conversion: { id: 3, sourceCRS: 0, targetCRS: 4, eastings: 8, northings: 48, orthogonalHeight: 0 },
    crs: { id: 4, name: 'EPSG:4326' },
  });
  await waitFor(() => probe.read().mapState === 'ready', 'latest origin resolved');
  const latestOrigin = probe.read().latLon;
  assert.ok(latestOrigin);
  assert.ok(Math.abs(latestOrigin.lat - 48) < 1e-10);
  assert.ok(Math.abs(latestOrigin.lon - 8) < 1e-10);
  // A genuine proj4 definition still runs through the real resolver and transform.
  await act(async () => {
    release(new Response('+proj=longlat +datum=WGS84 +no_defs'));
    await response;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
  assert.deepEqual(probe.read().latLon, latestOrigin);
  assert.equal(probe.read().mapState, 'ready');
  assert.equal(probe.read().errorKey, null);
  assert.equal(probe.read().geometryDistanceKm, null);
});

it('#6677 removing georeferencing resets the resolved origin, diagnostic and state', async () => {
  const probe = harness(swiss);
  await waitFor(() => probe.read().geometryDistanceKm !== null, 'Swiss placement discrepancy resolved');
  assert.ok(probe.read().geometryDistanceKm! > 2800);
  probe.update({});
  assert.equal(probe.read().latLon, null);
  assert.equal(probe.read().geometryDistanceKm, null);
  assert.equal(probe.read().errorKey, null);
  assert.equal(probe.read().mapState, 'idle');
});

it('#6677 unresolved metadata clears a previous origin and distance, then recovers', async () => {
  const probe = harness(swiss);
  await waitFor(() => probe.read().geometryDistanceKm !== null, 'initial diagnostic resolved');
  probe.update({ ...swiss, crs: { id: 5, name: 'Unresolvable custom grid' } });
  await waitFor(() => probe.read().mapState === 'error', 'unresolved CRS reported');
  assert.equal(probe.read().latLon, null);
  assert.equal(probe.read().geometryDistanceKm, null);
  assert.equal(probe.read().errorKey, 'properties.locationMap.projectionUnresolved');
  probe.update({ ...swiss, coordinateInfo: undefined });
  await waitFor(() => probe.read().mapState === 'ready', 'metadata-only origin recovered');
  assert.ok(Math.abs(probe.read().latLon!.lat - 47.52217553207048) < 0.000001);
  assert.ok(Math.abs(probe.read().latLon!.lon - 7.69186230636631) < 0.000001);
  assert.equal(probe.read().geometryDistanceKm, null);
  assert.equal(probe.read().errorKey, null);
});

const OUTSIDE_UTM_ORIGIN: Inputs = {
  // Stated invariant: tmerc cannot invert this declared anchor, but the
  // authored geometry placement cancels it into an ordinary UTM coordinate.
  // This exercises the same projection-coverage class as #6698's actual
  // EPSG:28992 MiniBIM, without a network-dependent precision-grid download.
  conversion: { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 100_000_000, northings: 4_000_000, orthogonalHeight: 0 },
  crs: { id: 3, name: 'EPSG:32610', mapUnitScale: 1 },
};
const PHYSICAL_UTM_FRAME: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
  shiftedBounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
  hasLargeCoordinates: false,
  wasmRtcOffset: { x: -99_500_000, y: 0, z: 10 },
};

it('#6698 physical location becomes ready when RTC metadata arrives outside the declared origin coverage', async () => {
  const probe = harness(OUTSIDE_UTM_ORIGIN);
  await waitFor(() => probe.read().mapState === 'error', 'the unprojectable origin must be reported before geometry exists');
  assert.equal(probe.read().latLon, null);
  probe.update({ ...OUTSIDE_UTM_ORIGIN, coordinateInfo: PHYSICAL_UTM_FRAME });
  await waitFor(() => probe.read().mapState === 'ready', 'physical geometry must become locatable after RTC publication');
  assert.equal(probe.read().locationKind, 'geometry');
  assert.equal(probe.read().errorKey, null);
  assert.ok(Math.abs(probe.read().latLon!.lon - -123) < 1e-8);
  // PROJ UTM zone10 reference at E500000/N4000000.
  assert.ok(Math.abs(probe.read().latLon!.lat - 36.14471809978956) < 1e-7);
  assert.equal(probe.read().geometryDistanceKm, null, 'an unresolved origin must not produce an invented distance');
  // Metadata disappearance and model replacement cannot retain the old centre.
  probe.update(OUTSIDE_UTM_ORIGIN);
  await waitFor(() => probe.read().mapState === 'error', 'removing geometry clears the physical location');
  assert.equal(probe.read().latLon, null);
  assert.equal(probe.read().locationKind, null);
  probe.update(swiss);
  await waitFor(() => probe.read().geometryDistanceKm !== null, 'a replacement model retains the declared-origin diagnostic');
  assert.equal(probe.read().locationKind, 'origin');
  assert.ok(probe.read().geometryDistanceKm! > 2800);
});

const NEUTRAL_UTM: Inputs = {
  conversion: { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 0, northings: 0, orthogonalHeight: 0 },
  crs: { id: 3, name: 'EPSG:32632', mapUnitScale: 1 },
};
const MAP_ABSOLUTE_UTM: CoordinateInfo = {
  ...PHYSICAL_UTM_FRAME,
  wasmRtcOffset: { x: 500_000, y: 4_000_000, z: 10 },
};

it('#6698 a neutral UTM operation displays the physical map frame after staged metadata, without rewriting its origin', async () => {
  // Canonicalized Haus has this same class: zero MapConversion offsets, with
  // absolute UTM geometry. UTM can mathematically invert its zero origin, so
  // merely checking for a failed projection would keep the map near latitude0.
  const conversion = Object.freeze({ ...NEUTRAL_UTM.conversion!, xAxisAbscissa: 1, xAxisOrdinate: 0 });
  const probe = harness({ ...NEUTRAL_UTM, conversion });
  await waitFor(() => probe.read().mapState === 'ready', 'the metadata-only declared origin is independently locatable');
  assert.equal(probe.read().locationKind, 'origin');
  assert.equal(probe.read().latLon!.lat, 0);
  probe.update({ ...NEUTRAL_UTM, conversion, coordinateInfo: MAP_ABSOLUTE_UTM });
  await waitFor(() => probe.read().locationKind === 'geometry', 'published physical geometry must take precedence for an effective identity');
  assert.ok(Math.abs(probe.read().latLon!.lon - 9) < 1e-8);
  assert.ok(Math.abs(probe.read().latLon!.lat - 36.14471809978956) < 1e-7);
  assert.equal(probe.read().geometryDistanceKm, null);
  const footprint = await computeFootprintGeoJSON(conversion, NEUTRAL_UTM.crs!, MAP_ABSOLUTE_UTM, 1);
  assert.ok(footprint);
  const midpointLon = (Math.min(...footprint.map(p => p[0])) + Math.max(...footprint.map(p => p[0]))) / 2;
  assert.ok(Math.abs(midpointLon - probe.read().latLon!.lon) < 1e-8, 'footprint and centre must consume the same canonical neutral direction');
  assert.equal(conversion.eastings, 0);
  assert.equal(conversion.xAxisAbscissa, 1, 'display must not rewrite the authored direction');
  probe.update({ ...NEUTRAL_UTM, conversion });
  await waitFor(() => probe.read().locationKind === 'origin', 'removing geometry must restore independent metadata-only origin');
  assert.equal(probe.read().latLon!.lat, 0);
});

it('#6698 explicit millimetre/metre bridging is physical identity, while scale and factors keep the declared origin', async () => {
  const inputs: Inputs = { ...NEUTRAL_UTM, coordinateInfo: MAP_ABSOLUTE_UTM, lengthUnitScale: 0.001,
    conversion: { ...NEUTRAL_UTM.conversion!, scale: 0.001 } };
  const probe = harness(inputs);
  await waitFor(() => probe.read().locationKind === 'geometry', 'the explicit0.001 bridge must preserve metre geometry');
  assert.ok(Math.abs(probe.read().latLon!.lon - 9) < 1e-8);
  for (const change of [{ scale: 0.002 }, { factorX: 2 }, { factorY: 2 }, { factorZ: 2 }]) {
    probe.update({ ...inputs, conversion: { ...inputs.conversion!, ...change } });
    await waitFor(() => probe.read().locationKind === 'origin' && probe.read().geometryDistanceKm !== null,
      'a genuinely nonneutral physical scale retains the declared-origin diagnostic');
    assert.equal(probe.read().latLon!.lat, 0);
  }
});

it('#6698 malformed Scale and a reversed X axis are never classified as effective identity', async () => {
  const probe = harness({ ...NEUTRAL_UTM, coordinateInfo: MAP_ABSOLUTE_UTM });
  await waitFor(() => probe.read().locationKind === 'geometry', 'positive neutral control');
  for (const change of [{ scale: Number.NaN }, { scale: -1, factorX: -1, factorY: -1, factorZ: -1 }, { xAxisAbscissa: -1 }, { xAxisAbscissa: 2 }, { xAxisOrdinate: 1 }]) {
    probe.update({ ...NEUTRAL_UTM, coordinateInfo: MAP_ABSOLUTE_UTM, conversion: { ...NEUTRAL_UTM.conversion!, ...change } });
    await waitFor(() => probe.read().locationKind === 'origin', 'invalid or nonneutral declarations must preserve origin display');
    assert.equal(probe.read().latLon!.lat, 0);
  }
  probe.update({ conversion: { ...NEUTRAL_UTM.conversion!, sourceCRS: 2, targetCRS: 4 },
    crs: { id: 4, name: 'EPSG:4326' }, coordinateInfo: MAP_ABSOLUTE_UTM });
  await waitFor(() => probe.read().latLon!.lon === 0, 'a replacement geographic CRS resolves its declared degrees');
  assert.equal(probe.read().locationKind, 'origin', 'metre geometry must not be added to geographic degrees');
});
