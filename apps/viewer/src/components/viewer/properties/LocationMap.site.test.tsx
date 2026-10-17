/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { IfcParser, type IfcDataStore, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { GeoreferencingPanel } from './GeoreferencingPanel.js';
import { cleanup, render, waitFor } from '@/test/render.js';
import { markMapWebglUnsupported, resetMapWebglSupportForTests } from '@/lib/geo/map-webgl-support.js';
import { readSiteLocationReference, siteLocationDisagreement } from '@/lib/geo/site-location-disagreement.js';
import { reprojectPointToLatLon } from '@/lib/geo/reproject.js';
import { LocationMap } from './LocationMap.js';

// #7666: a real STEP parse, not a mocked getter. The reference values are the
// reporter's PROJ9/QGIS oracle in #7658. This minimal fixture states only the
// placement/angle invariants and makes no claim to be an authoring-tool model.
async function siteStore(options: {
  latitude?: string; longitude?: string; position?: string; parent?: string;
  unit?: string; cycle?: boolean; multiple?: boolean; missingPlacement?: boolean;
} = {}) {
  const source = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,(#10),#20);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);
#20=IFCUNITASSIGNMENT((#21));
#21=IFCSIUNIT(*,.LENGTHUNIT.,${options.unit ?? '$'},.METRE.);
#30=IFCCARTESIANPOINT((${options.parent ?? '0.,0.,0.'}));
#31=IFCDIRECTION((0.,1.,0.));
#32=IFCAXIS2PLACEMENT3D(#30,$,#31);
#33=IFCLOCALPLACEMENT(${options.cycle ? '#36' : '$'},#32);
#34=IFCCARTESIANPOINT((${options.position ?? '0.,0.,0.'}));
#35=IFCAXIS2PLACEMENT3D(#34,$,$);
#36=IFCLOCALPLACEMENT(#33,#35);
#40=IFCSITE('Site000000000000000001',$,'Site',$,$,${options.missingPlacement ? '$' : '#36'},$,$,.ELEMENT.,${options.latitude ?? '(50,25,51,826800)'},${options.longitude ?? '(7,31,16,129200)'},0.,$,$);
${options.multiple ? "#41=IFCSITE('Site000000000000000002',$,'Other',$,$,#36,$,$,.ELEMENT.,(51,0,0),(8,0,0),0.,$,$);" : ''}
ENDSEC;
END-ISO-10303-21;`;
  return new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer as ArrayBuffer, { disableWorkerScan: true });
}

const conversion: MapConversion = { id: 50, sourceCRS: 10, targetCRS: 51,
  eastings: 3395000, northings: 5589400, orthogonalHeight: 0 };
const crs: ProjectedCRS = { id: 51, name: 'EPSG:9933', mapUnitScale: 1 };
const originalFetch = globalThis.fetch;
const originalState = useViewerStore.getState();
afterEach(() => { cleanup(); resetMapWebglSupportForTests(); globalThis.fetch = originalFetch; useViewerStore.setState(originalState, true); });

it('#7666 DB_REF oracle stays quiet; a genuine 100m disagreement appears and clears on model/CRS edits', async () => {
  markMapWebglUnsupported('probe_no_context');
  const store = await siteStore();
  let change!: (next: { dataStore?: IfcDataStore; mapConversion: MapConversion; projectedCRS: ProjectedCRS }) => void;
  function Panel() {
    const [input, setInput] = useState<{ dataStore?: IfcDataStore; mapConversion: MapConversion; projectedCRS: ProjectedCRS }>({ dataStore: store, mapConversion: conversion, projectedCRS: crs });
    change = setInput;
    return <LocationMap {...input} />;
  }
  const ui = render(<Panel />);
  await waitFor(() => ui.querySelector('a[href*="google.com/maps"]') !== null, 'real DB_REF origin resolves');
  assert.equal(ui.querySelector('output'), null, 'the corrected datum agrees with the independent PROJ oracle');
  const shifted = { ...conversion, eastings: conversion.eastings + 100 };
  act(() => change({ dataStore: store, mapConversion: shifted, projectedCRS: crs }));
  await waitFor(() => ui.textContent?.includes('IfcSite RefLatitude/RefLongitude differs') === true, 'a genuine disagreement is visible');
  assert.match(ui.querySelector('output')!.textContent!, /about 100 m/);
  assert.match(ui.textContent!, /datum in the source model/);
  act(() => change({ dataStore: store, mapConversion: shifted, projectedCRS: { ...crs, name: 'Unresolvable custom CRS' } }));
  await waitFor(() => ui.textContent?.includes('Could not resolve projection') === true, 'unresolved CRS settles');
  assert.equal(ui.querySelector('output'), null);
  act(() => change({ dataStore: store, mapConversion: shifted, projectedCRS: crs }));
  await waitFor(() => ui.querySelector('output') !== null, 'diagnostic recovers');
  act(() => change({ dataStore: undefined, mapConversion: shifted, projectedCRS: crs }));
  await waitFor(() => ui.querySelector('a[href*="google.com/maps"]') !== null, 'replacement without site resolves');
  assert.equal(ui.querySelector('output'), null, 'another model cannot inherit the site diagnostic');
});

it('#7666 transforms the nested site origin with parent rotation, mm project units, map feet and scaled axes', async () => {
  // Parent rotates local (3000,4000)mm to (-4,3)m, then adds (10,20)m.
  const store = await siteStore({ unit: '.MILLI.', parent: '10000.,20000.,0.', position: '3000.,4000.,0.' });
  const reference = readSiteLocationReference(store)!;
  assert.deepEqual(reference.origin, { x: 6, y: 23, z: 0 });
  // Map rotation (0,2) normalizes to (0,1); Scale bridges mm->feet and
  // FactorX/Y scale (6,23)m to (12,69)m, rotated to (-69,12)m.
  const feet = { ...crs, name: 'EPSG:32632', mapUnitScale: 0.3048 };
  const scaled = { ...conversion, eastings: 500000 / 0.3048, northings: 4000000 / 0.3048,
    scale: 0.001 / 0.3048, xAxisAbscissa: 0, xAxisOrdinate: 2, factorX: 2, factorY: 3 };
  const origin = await reprojectPointToLatLon(scaled.eastings, scaled.northings, feet, 0.001);
  const placed = await reprojectPointToLatLon((500000 - 69) / 0.3048, (4000000 + 12) / 0.3048, feet, 0.001);
  assert.ok(origin && placed);
  assert.equal(await siteLocationDisagreement({ ...reference, location: placed }, origin, scaled, feet, 0.001), null);
  assert.ok((await siteLocationDisagreement({ ...reference, location: origin }, origin, scaled, feet, 0.001))! > 69,
    'raw MapConversion E/N is not the site origin');
});

it('#7666 whole-second angles admit their rounding error while millionths retain a five-metre floor', async () => {
  const coarse = readSiteLocationReference(await siteStore({ latitude: '(50,25,52)', longitude: '(7,31,16)' }))!;
  const fine = readSiteLocationReference(await siteStore())!;
  const origin = await reprojectPointToLatLon(conversion.eastings, conversion.northings, crs);
  assert.ok(origin);
  assert.equal(await siteLocationDisagreement(coarse, origin, conversion, crs, 1), null,
    'whole-second rounding of the reported oracle must not trigger');
  assert.ok(coarse.precisionMetres > 15);
  assert.ok(fine.precisionMetres < 0.001);
  for (const [metres, expected] of [[4, false], [6, true], [30, true]] as const) {
    const location = { ...origin, lat: origin.lat + metres / 6371000 * 180 / Math.PI };
    const distance = await siteLocationDisagreement({ ...fine, location }, origin, conversion, crs, 1);
    assert.equal(distance !== null, expected);
  }
  const far = { ...origin, lat: origin.lat + 40 / 6371000 * 180 / Math.PI };
  assert.ok((await siteLocationDisagreement({ ...coarse, location: far }, origin, conversion, crs, 1))! >= 39);
});

it('#7666 placeholders, missing/malformed angles, ambiguous sites and broken placement chains cannot invent a warning', async () => {
  for (const options of [
    { latitude: '(0,0,0)', longitude: '(0,0,0)' },
    { latitude: '(0,0,0,0)', longitude: '(0,0,0,0)' },
    { latitude: '$' }, { longitude: '(181,0,0)' }, { latitude: '(50,60,0)' },
    { latitude: '(50,$,0)' }, { cycle: true }, { multiple: true }, { missingPlacement: true },
  ]) assert.equal(readSiteLocationReference(await siteStore(options)), undefined, JSON.stringify(options));
  const signed = readSiteLocationReference(await siteStore({ latitude: '(0,-30,0)', longitude: '(-7,-31,-16,-129200)' }))!;
  assert.equal(signed.location.lat, -0.5);
  assert.ok(Math.abs(signed.location.lon + 7.521147) < 1e-10);
});

it('#7666 neutral map operations stay quiet even before geometry metadata is available', async () => {
  markMapWebglUnsupported('probe_no_context');
  const store = await siteStore();
  const ui = render(<LocationMap dataStore={store} mapConversion={{ ...conversion, eastings: 0, northings: 0 }}
    projectedCRS={{ ...crs, name: 'EPSG:32632' }} />);
  await waitFor(() => ui.querySelector('a[href*="google.com/maps"]') !== null, 'neutral origin resolves');
  assert.equal(ui.querySelector('output'), null, 'UTM zero must not compare the site against the equator');
});

it('#7666 a pending old site comparison cannot write into a replacement model', async () => {
  markMapWebglUnsupported('probe_no_context');
  const store = await siteStore();
  let release!: (response: Response) => void;
  let requested = false;
  const response = new Promise<Response>(resolve => { release = resolve; });
  globalThis.fetch = async () => { requested = true; return response; };
  let replace!: () => void;
  function Panel() {
    const [old, setOld] = useState(true);
    replace = () => setOld(false);
    return <LocationMap dataStore={old ? store : undefined} mapConversion={conversion}
      projectedCRS={old ? { ...crs, name: 'EPSG:9997666' } : crs} />;
  }
  const ui = render(<Panel />);
  await waitFor(() => requested, 'old projection request started');
  act(replace);
  await waitFor(() => ui.querySelector('a[href*="google.com/maps"]') !== null, 'replacement origin resolves');
  await act(async () => {
    release(new Response('+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=3500000 +y_0=0 +ellps=bessel +units=m +no_defs'));
    await response;
  });
  assert.equal(ui.querySelector('output'), null);
});

it('#7666 the georeferencing panel compares only its own model in a federation of one or many', async () => {
  markMapWebglUnsupported('probe_no_context');
  const store = await siteStore();
  const placeholder = await siteStore({ latitude: '(0,0,0)', longitude: '(0,0,0)' });
  const georef = { hasGeoreference: true, source: 'mapConversion' as const,
    mapConversion: { ...conversion, eastings: conversion.eastings + 100 }, projectedCRS: crs };
  for (const federated of [false, true]) {
    useViewerStore.setState({
      ...fixtureModels({ ...fixtureModel('site'), ifcDataStore: store },
        ...(federated ? [{ ...fixtureModel('other', { idOffset: 1_000_000 }), ifcDataStore: placeholder }] : [])),
      georefMutations: new Map(),
    });
    const ui = render(<GeoreferencingPanel georef={georef} modelId="site" schemaVersion="IFC4" />);
    await waitFor(() => ui.textContent?.includes('about 100 m') === true, 'the selected model site reaches the map');
    cleanup();
    if (federated) {
      const other = render(<GeoreferencingPanel georef={georef} modelId="other" schemaVersion="IFC4" />);
      await waitFor(() => other.querySelector('a[href*="google.com/maps"]') !== null, 'the other model resolves');
      assert.equal(other.querySelector('output'), null, 'a site in another model must not leak into this panel');
      cleanup();
    }
  }
});
