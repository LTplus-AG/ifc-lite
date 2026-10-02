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
  assert.deepEqual(probe.read().latLon, { lat: 48, lon: 8 });
  // A genuine proj4 definition still runs through the real resolver and transform.
  await act(async () => {
    release(new Response('+proj=longlat +datum=WGS84 +no_defs'));
    await response;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
  assert.deepEqual(probe.read().latLon, { lat: 48, lon: 8 });
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
