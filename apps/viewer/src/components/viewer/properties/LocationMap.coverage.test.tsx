/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { cleanup, render, waitFor } from '@/test/render.js';
import { markMapWebglUnsupported, resetMapWebglSupportForTests } from '@/lib/geo/map-webgl-support.js';
import { LocationMap } from './LocationMap.js';

afterEach(() => { cleanup(); resetMapWebglSupportForTests(); });

it('#6698 a physical location has honest labels and links after staged RTC publication', async () => {
  // A WebGL-free device still receives real projection output and location
  // links. Only hardware availability is gated; no projection is mocked.
  markMapWebglUnsupported('probe_no_context');
  let publish: (frame: CoordinateInfo | undefined) => void = () => { throw new Error('Not mounted'); };
  function StagedModel() {
    const [frame, setFrame] = useState<CoordinateInfo>();
    publish = setFrame;
    return <LocationMap
      mapConversion={{ id: 1, sourceCRS: 2, targetCRS: 3, eastings: 100_000_000, northings: 4_000_000, orthogonalHeight: 0 }}
      projectedCRS={{ id: 3, name: 'EPSG:32610', mapUnitScale: 1 }}
      coordinateInfo={frame}
    />;
  }
  const ui = render(<StagedModel />);
  await waitFor(() => ui.textContent?.includes('Could not resolve projection') === true, 'missing geometry cannot locate an unprojectable origin');
  act(() => publish({
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
    shiftedBounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
    hasLargeCoordinates: false,
    wasmRtcOffset: { x: -99_500_000, y: 0, z: 10 },
  }));
  await waitFor(() => ui.textContent?.includes('Showing the model location') === true, 'physical location must be explicitly distinguished from the declared origin');
  assert.ok(!ui.textContent?.includes('Could not resolve projection'));
  assert.ok(ui.querySelector('span[title="Model Lat/Lon"]'));
  assert.ok(!ui.textContent?.includes('Origin Lat/Lon'));
  const maps = ui.querySelector<HTMLAnchorElement>('a[href*="google.com/maps"]');
  assert.ok(maps, 'physical location must remain usable without WebGL');
  const [lat, lon] = new URL(maps.href).searchParams.get('q')!.split(',').map(Number);
  assert.ok(Math.abs(lon + 123) < 1e-8);
  assert.ok(Math.abs(lat - 36.14471809978956) < 1e-7);
  assert.ok(ui.querySelector('a[href*="openstreetmap.org"]'));
  act(() => publish(undefined));
  await waitFor(() => ui.textContent?.includes('Could not resolve projection') === true, 'removed geometry cannot leave an old physical link');
  assert.equal(ui.querySelector('a[href*="google.com/maps"]'), null);
});


it('#6698 canonical absolute UTM geometry replaces a finite zero origin without editing it', async () => {
  markMapWebglUnsupported('probe_no_context');
  const conversion = Object.freeze({ id: 1, sourceCRS: 2, targetCRS: 3, eastings: 0, northings: 0, orthogonalHeight: 0 });
  let publish: (frame: CoordinateInfo | undefined) => void = () => { throw new Error('Not mounted'); };
  function StagedModel() {
    const [frame, setFrame] = useState<CoordinateInfo>();
    publish = setFrame;
    return <LocationMap mapConversion={conversion}
      projectedCRS={{ id: 3, name: 'EPSG:32632', mapUnitScale: 1 }} coordinateInfo={frame} />;
  }
  const ui = render(<StagedModel />);
  await waitFor(() => ui.querySelector('span[title="Origin Lat/Lon"]') !== null, 'UTM zero is independently invertible');
  act(() => publish({
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
    shiftedBounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
    hasLargeCoordinates: true, wasmRtcOffset: { x: 500_000, y: 4_000_000, z: 10 },
  }));
  await waitFor(() => ui.querySelector('span[title="Model Lat/Lon"]') !== null, 'physical frame must replace abstract zero origin');
  assert.ok(ui.textContent?.includes('declared origin remains unchanged'));
  const link = ui.querySelector<HTMLAnchorElement>('a[href*="google.com/maps"]');
  assert.ok(link);
  const [lat, lon] = new URL(link.href).searchParams.get('q')!.split(',').map(Number);
  assert.ok(Math.abs(lon - 9) < 1e-8);
  assert.ok(Math.abs(lat - 36.14471809978956) < 1e-7);
  assert.equal(conversion.eastings, 0);
  act(() => publish(undefined));
  await waitFor(() => ui.querySelector('span[title="Origin Lat/Lon"]') !== null, 'removed frame restores metadata-only origin');
  assert.ok(!ui.textContent?.includes('Showing the model location'));
});
