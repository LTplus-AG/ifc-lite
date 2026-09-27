/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5942 follow-up: a tile server that ANSWERS, but not with an image, is
 * reported as what it said, not blamed on cross-origin rules.
 *
 * Found with a live server: a real MapServer WMS asked for a CRS it does not
 * serve returns HTTP 200 with the `ServiceException` below (verbatim), and the
 * drape told the user to fix CORS. Only a fetch that gets no answer at all
 * (the bare TypeError a CORS refusal produces) keeps the CORS explanation.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureModel } from '@/test/store-fixture.js';
import { orthoTerrainDocument } from '@/lib/terrain-imagery/synthetic-orthophoto.fixture.js';
import { drapeTileSource } from './terrainImageryTiles.js';

const INVALID_SRS = `<?xml version='1.0' encoding="UTF-8" standalone="no" ?>
<!DOCTYPE ServiceExceptionReport SYSTEM "http://schemas.opengis.net/wms/1.1.1/exception_1_1_1.dtd">
<ServiceExceptionReport version="1.1.1">
<ServiceException code="InvalidSRS">
msWMSLoadGetMapParams(): WMS server error. Invalid SRS given : SRS must be valid for all requested layers.
</ServiceException>
</ServiceExceptionReport>`;

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function answer(respond: () => Response | Promise<Response>): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    requested.push(String(url));
    return respond();
  }) as typeof globalThis.fetch;
  return requested;
}

/** The synthetic LV95 terrain (see its fixture header) as a loaded model. */
function terrain() {
  return { ...fixtureModel('terrain'), landXmlDocument: orthoTerrainDocument() };
}

const WMS = { kind: 'wms', url: 'https://wms.example.org/service', layers: 'ortho', resolution: 0.5 } as const;

describe('tile-source server answers (#5942 follow-up)', () => {
  it('reports a WMS ServiceException sent with HTTP 200 as the server\'s refusal, naming the terrain CRS', async () => {
    const requested = answer(() => new Response(INVALID_SRS, {
      status: 200, headers: { 'content-type': 'application/vnd.ogc.se_xml; charset=UTF-8' },
    }));
    const result = await drapeTileSource(terrain(), WMS);
    assert.equal(requested.length, 1);
    assert.match(requested[0], /SRS=EPSG%3A2056|SRS=EPSG:2056/);
    assert.equal(result.ok, false);
    const reason = result.ok ? '' : result.reason;
    assert.match(reason, /wms\.example\.org answered with an OGC exception \(InvalidSRS\): msWMSLoadGetMapParams\(\): WMS server error\. Invalid SRS given/);
    assert.match(reason, /layers\. This WMS does not serve EPSG:2056/);
    assert.doesNotMatch(reason, /cross-origin/);
  });

  it('reports an HTTP error and a non-image answer as the server\'s, not as CORS', async () => {
    answer(() => new Response('gone', { status: 404 }));
    const missing = await drapeTileSource(terrain(), WMS);
    assert.match(missing.ok ? '' : missing.reason, /refused the request: wms\.example\.org answered HTTP 404/);
    assert.doesNotMatch(missing.ok ? '' : missing.reason, /cross-origin/);

    answer(() => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const html = await drapeTileSource(terrain(), WMS);
    assert.match(html.ok ? '' : html.reason, /answered text\/html, not an image/);
  });

  it('keeps the cross-origin explanation for a fetch that got no answer at all', async () => {
    answer(() => { throw new TypeError('Failed to fetch'); });
    const result = await drapeTileSource(terrain(), WMS);
    assert.match(result.ok ? '' : result.reason, /could not be fetched \(Failed to fetch\)\. The server must allow cross-origin requests/);
  });
});
