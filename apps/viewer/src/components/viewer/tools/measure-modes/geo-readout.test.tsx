/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lat/lon half of the measure tool's geo readout resolves through proj4,
 * which is asynchronous — and the row it feeds sits directly under a synchronous
 * E/N readout that updates on the same click.
 *
 * That gap is the whole subject here: between picking a new point and the
 * reprojection resolving, the component must show NOTHING rather than the
 * previous point's coordinates. A stale lat/lon under a fresh label is
 * indistinguishable from a correct one, which makes it worse than an absent
 * row — the same "state the basis, never guess" rule the rest of #2199 follows.
 */

import '@/test/setup-dom.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useProjectedLatLon } from './geo-readout.js';
import type { AnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';

/**
 * building-architecture.ifc's georeference (EPSG:32760, UTM 60S), the same
 * fixture `lib/geo/reproject.test.ts` uses — a real CRS proj4 can resolve, so
 * the async hop genuinely happens rather than short-circuiting to `null`.
 */
const ANCHOR = {
  eff: {
    mapConversion: {
      eastings: 729013348.8297004,
      northings: 9063992684.697363,
      orthogonalHeight: 0,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
      scale: 1,
    },
    projectedCRS: { id: 18, name: 'EPSG:32760', mapUnit: 'MILLIMETRE', mapUnitScale: 0.001 },
    lengthUnitScale: 0.001,
  },
  originViewer: { x: 0, y: 0, z: 0 },
} as unknown as AnchorGeoreference;

const mounted: Array<{ root: Root; host: HTMLElement }> = [];
after(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

/**
 * Flush pending promise jobs inside `act` until `done()` holds, so a resolved
 * reprojection is committed before the next assertion reads it. Polled rather
 * than a fixed number of ticks: `resolveProjection` loads its definition
 * lazily, so the number of microtask hops is an implementation detail.
 */
async function settle(done: () => boolean = () => true): Promise<void> {
  for (let i = 0; i < 50 && !done(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

describe('the picked point\'s lat/lon never lags behind the point', () => {
  it('clears the previous coordinates while the new ones are in flight', async () => {
    const seen: Array<{ lat: number; lon: number } | null> = [];
    function Probe({ point }: { point: { x: number; y: number; z: number } }) {
      seen.push(useProjectedLatLon(point, ANCHOR));
      return null;
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ root, host });

    act(() => root.render(<Probe point={{ x: 0, y: 0, z: 0 }} />));
    await settle(() => seen.at(-1) !== null && seen.at(-1) !== undefined);
    const first = seen.at(-1);
    assert.ok(first, 'the fixture CRS must actually resolve, or this test proves nothing');

    // A point 20 km east (viewer units are metres): far enough that its lat/lon
    // differs beyond any rounding, near enough to stay inside the projection.
    seen.length = 0;
    act(() => root.render(<Probe point={{ x: 20_000, y: 0, z: 0 }} />));
    assert.equal(
      seen.at(-1),
      null,
      `the render right after the pick still showed the old point's lat/lon: ${JSON.stringify(seen)}`,
    );

    await settle(() => seen.at(-1) !== null && seen.at(-1) !== undefined);
    const second = seen.at(-1);
    assert.ok(second, 'and the new coordinates must arrive');
    assert.notDeepEqual(second, first, 'a 50 km move must change the lat/lon');
  });

  it('is null with no anchor, and stays null once the anchor goes away', async () => {
    const seen: Array<{ lat: number; lon: number } | null> = [];
    function Probe({ anchor }: { anchor: AnchorGeoreference | null }) {
      seen.push(useProjectedLatLon({ x: 0, y: 0, z: 0 }, anchor));
      return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ root, host });

    act(() => root.render(<Probe anchor={ANCHOR} />));
    await settle(() => seen.at(-1) !== null && seen.at(-1) !== undefined);
    assert.ok(seen.at(-1), 'resolved with an anchor');

    act(() => root.render(<Probe anchor={null} />));
    await settle();
    assert.equal(seen.at(-1), null, 'dropping the georeference must drop the readout');
  });
});
