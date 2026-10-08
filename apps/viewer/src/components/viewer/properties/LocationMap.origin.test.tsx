/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IfcParser, extractGeoreferencingOnDemand } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { cleanup, click, render, type, waitFor } from '@/test/render.js';
import { markMapWebglUnsupported, resetMapWebglSupportForTests } from '@/lib/geo/map-webgl-support.js';
import { reprojectPointToLatLon, reprojectToLatLon } from '@/lib/geo/reproject.js';
import { LocationMap, type PickedPosition } from './LocationMap.js';

// #6677: records from the public Allplan attachment. LOCATION_GEOREF_IFC
// optionally runs the same component oracle against the complete source file:
// https://github.com/user-attachments/files/32949575/ifc.txt
const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('georef.ifc','2026-09-30T00:00:00',(),(),'test','test','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000000',$,'Georef test',$,$,$,$,(#59),#2);
#2=IFCUNITASSIGNMENT((#62));
#59=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#64,$);
#63=IFCCARTESIANPOINT((0.,0.,0.));
#64=IFCAXIS2PLACEMENT3D(#63,$,$);
#60=IFCMAPCONVERSION(#59,#61,2619073.0368,1263523.6017,0.,$,$,$);
#61=IFCPROJECTEDCRS('EPSG:2056','CH1903+ / LV95','CH1903+','EPSG:5728',$,$,#62);
#62=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#90=IFCCARTESIANPOINT((-2619042.5367503,-1263543.60168925,0.));
ENDSEC;
END-ISO-10303-21;`;

// Captured from the production loader for that exact attachment. Bounds are
// Y-up and RTC is IFC Z-up; no originShift was applied. The recovered centre
// nearly cancels MapConversion, while its declared origin is in Switzerland.
const bounds = {
  min: { x: -13.367027819156647, y: -6, z: -5.200000017881393 },
  max: { x: 30.44999998807907, y: 5.000000014901161, z: 10.449999988079071 },
};
const info: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds,
  hasLargeCoordinates: false, lengthUnitScale: 1,
  wasmRtcOffset: { x: -2619072.9867503, y: -1263533.65168925, z: 0 },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  resetMapWebglSupportForTests();
  globalThis.fetch = originalFetch;
});

async function georef() {
  const bytes = process.env.LOCATION_GEOREF_IFC
    ? new Uint8Array(readFileSync(process.env.LOCATION_GEOREF_IFC))
    : new TextEncoder().encode(source);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, {});
  const result = extractGeoreferencingOnDemand(store);
  assert.ok(result?.projectedCRS && result.mapConversion);
  return { crs: result.projectedCRS, conversion: result.mapConversion };
}

it('#6677 shows the Swiss declared origin independently of negative element placements', async () => {
  const { crs, conversion } = await georef();
  markMapWebglUnsupported('probe_no_context');
  const ui = render(<LocationMap mapConversion={conversion} projectedCRS={crs} coordinateInfo={info} />);
  await waitFor(() => ui.textContent?.includes('47.52218, 7.69186') === true, 'Pratteln origin readout');
  await waitFor(() => ui.textContent?.includes('Check the element placements') === true, 'geometry discrepancy');
  const link = ui.querySelector<HTMLAnchorElement>('a[href*="google.com/maps"]');
  assert.ok(link);
  assert.ok(link.href.includes('47.522175') && link.href.includes('7.691862'), link.href);
  // Do not silently rebase file geometry to make the marker look correct.
  const center = await reprojectToLatLon(conversion, crs, info);
  assert.ok(center);
  assert.ok(Math.abs(center.lat - 32.12441) < 0.00001);
  assert.ok(Math.abs(center.lon + 19.91787) < 0.00001);
});

for (const variant of ['metre', 'millimetre MapUnit', 'absent MapUnit with millimetre project', 'map-absolute']) {
it(`#6677 searched origin saves projected coordinates with ${variant}`, async () => {
  const { crs, conversion } = await georef();
  markMapWebglUnsupported('probe_no_context');
  if (variant === 'millimetre MapUnit') {
    crs.mapUnit = 'MILLIMETRE'; crs.mapUnitScale = 0.001;
    conversion.eastings *= 1000; conversion.northings *= 1000;
  }
  if (variant === 'absent MapUnit with millimetre project') {
    crs.mapUnit = undefined; crs.mapUnitScale = undefined;
  }
  const pickedEasting = conversion.eastings + 100 / (crs.mapUnitScale ?? 1);
  const pickedNorthing = conversion.northings + 100 / (crs.mapUnitScale ?? 1);
  const picked = await reprojectPointToLatLon(pickedEasting, pickedNorthing, crs);
  assert.ok(picked);
  const frame = variant === 'map-absolute' ? { ...info, wasmRtcOffset: {
    x: 2619073.0368, y: 1263523.6017, z: 0,
  } } : info;
  const rotated = { ...conversion, xAxisAbscissa: 0.6, xAxisOrdinate: 0.8, scale: 2 };
  globalThis.fetch = async input => String(input).includes('nominatim')
    ? new Response(JSON.stringify([{ lat: String(picked.lat), lon: String(picked.lon), display_name: 'Pratteln oracle' }]))
    : new Response('{}', { status: 503 });
  let applied: PickedPosition | undefined;
  const ui = render(<LocationMap mapConversion={rotated} projectedCRS={crs} coordinateInfo={frame}
    lengthUnitScale={variant === 'absent MapUnit with millimetre project' ? 0.001 : 1} editable onApplyPosition={position => { applied = position; }} />);
  await waitFor(() => ui.querySelector('button[aria-label="Search for a place"]') !== null, 'search control');
  click(ui.querySelector('button[aria-label="Search for a place"]')!);
  const search = ui.querySelector<HTMLInputElement>('input[placeholder="Search for a place..."]');
  assert.ok(search);
  type(search, 'Pratteln');
  await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Pratteln oracle'), 'search result');
  click([...document.querySelectorAll('button')].find(b => b.textContent === 'Pratteln oracle')!);
  const apply = () => [...ui.querySelectorAll('button')].find(b => b.textContent?.includes('Apply to Eastings'));
  await waitFor(() => Boolean(apply() && !apply()!.disabled), 'projected coordinates ready');
  click(apply()!);
  assert.ok(applied);
  assert.ok(Math.abs(applied.easting - pickedEasting) * (crs.mapUnitScale ?? 1) < 0.01, `E ${applied.easting}`);
  assert.ok(Math.abs(applied.northing - pickedNorthing) * (crs.mapUnitScale ?? 1) < 0.01, `N ${applied.northing}`);
  if (variant === 'map-absolute') {
    const before = await reprojectToLatLon(rotated, crs, frame);
    const after = await reprojectToLatLon({ ...rotated,
      eastings: applied.easting, northings: applied.northing,
    }, crs, frame);
    assert.deepEqual(after, before, 'nearby origin edits retain the existing map-absolute correction');
  }
});
}

for (const variant of ['local geometry', 'millimetre map unit', 'LV95 alias', 'metadata only']) {
  it(`#6677 declared origin remains stable with ${variant}`, async () => {
    const { crs, conversion } = await georef();
    markMapWebglUnsupported('probe_no_context');
    const localBounds = { min: { x: 10, y: 0, z: -30 }, max: { x: 20, y: 5, z: -20 } };
    const localInfo: CoordinateInfo = {
      originShift: { x: 0, y: 0, z: 0 }, originalBounds: localBounds,
      shiftedBounds: localBounds, hasLargeCoordinates: false,
    };
    if (variant === 'millimetre map unit') {
      crs.mapUnit = 'MILLIMETRE';
      crs.mapUnitScale = 0.001;
      conversion.eastings *= 1000;
      conversion.northings *= 1000;
    }
    if (variant === 'LV95 alias') crs.name = 'LV95';
    const ui = render(<LocationMap mapConversion={{ ...conversion,
      xAxisAbscissa: 0.6, xAxisOrdinate: 0.8, scale: 2, factorX: 0.9996,
    }} projectedCRS={crs} coordinateInfo={variant === 'metadata only' ? undefined : localInfo} />);
    await waitFor(() => ui.textContent?.includes('47.52218, 7.69186') === true, 'origin independent of mesh transform');
    assert.ok(!ui.textContent?.includes('Check the element placements'), 'ordinary local bounds need no distance warning');
  });
}
