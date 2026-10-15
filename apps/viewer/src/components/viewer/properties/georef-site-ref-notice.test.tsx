/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IfcSite RefLatitude/RefLongitude vs the IfcMapConversion position (#7658).
 * Synthetic DB_REF2016 model: MapConversion E 3395000 / N 5589400 in
 * EPSG:9933, which PROJ places at 50.431063 / 7.521147.
 */
import '@/test/setup-dom.js';
import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import { cleanup, render, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { readSiteRefLocation, siteRefMismatchMetres } from '@/lib/geo/site-ref-mismatch';
import { SiteRefMismatchNotice } from './georef-site-ref-notice.js';

const CONVERSION: MapConversion = {
  id: 61, sourceCRS: 20, targetCRS: 60, eastings: 3_395_000, northings: 5_589_400,
  orthogonalHeight: 0, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
};
const CRS: ProjectedCRS = { id: 60, name: 'EPSG:9933', mapUnitScale: 1 } as ProjectedCRS;

/** RefLatitude/RefLongitude as IfcCompoundPlaneAngleMeasure literals. */
const CORRECT = { lat: '(50,25,51,826800)', lon: '(7,31,16,127760)' };
/** Where the viewer used to put this MapConversion: no datum shift, ~146 m NNE. */
const SHIFTED = { lat: '(50,25,56,139600)', lon: '(7,31,19,110000)' };

async function parseSite(site: { lat: string; lon: string }): Promise<IfcDataStore> {
  const step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0000000000000000000PRJ',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#50= IFCSITE('000000000000000000SITE',$,'Site',$,$,#40,$,$,.ELEMENT.,${site.lat},${site.lon},0.,$,$);
#60= IFCPROJECTEDCRS('EPSG:9933',$,$,$,$,$,$);
#61= IFCMAPCONVERSION(#20,#60,3395000.,5589400.,0.,1.,0.,1.);
ENDSEC;
END-ISO-10303-21;
`;
  const bytes = new TextEncoder().encode(step);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

describe('IfcSite reference vs MapConversion position (#7658)', () => {
  let initialState: ReturnType<typeof useViewerStore.getState>;
  before(() => { initialState = useViewerStore.getState(); });
  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState, true);
  });

  it('reads RefLatitude/RefLongitude from the IfcSite', async () => {
    const site = readSiteRefLocation(await parseSite(CORRECT));
    assert.ok(site);
    assert.ok(Math.abs(site.lat - 50.431063) < 1e-6, `${site.lat}`);
    assert.ok(Math.abs(site.lon - 7.521147) < 1e-6, `${site.lon}`);
  });

  it('stays quiet when the site agrees with the MapConversion', async () => {
    const site = readSiteRefLocation(await parseSite(CORRECT));
    assert.equal(await siteRefMismatchMetres(site, CONVERSION, CRS), null);
  });

  it('warns when the site is ~146 m from the MapConversion position', async () => {
    const store = await parseSite(SHIFTED);
    const metres = await siteRefMismatchMetres(readSiteRefLocation(store), CONVERSION, CRS);
    assert.ok(metres !== null && Math.abs(metres - 146) < 2, `${metres}`);

    useViewerStore.setState({
      models: new Map([['m', { id: 'm', name: 'm', ifcDataStore: store, geometryResult: null, visible: true, idOffset: 0, maxExpressId: 100, loadedAt: 1 }]]) as never,
    });
    const container = render(<SiteRefMismatchNotice modelId="m" crs={CRS} conversion={CONVERSION} />);
    await waitFor(() => container.textContent?.includes('IfcSite RefLatitude') ?? false, 'mismatch notice renders');
    assert.match(container.textContent ?? '', /IfcSite RefLatitude\/RefLongitude is about 146 m from/);
  });
});
