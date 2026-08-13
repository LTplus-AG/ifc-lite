/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Place search, split out of LocationMap.tsx and tested for the first time.
 *
 * Its contract is "always resolves, never rejects": the Location panel calls it
 * from a debounced effect with no rejection handling, so a throw here — a
 * geocoder that is down, rate-limiting, or unreachable offline — would surface
 * as an unhandled rejection over a map the user can still pan and use.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { geocodeSearch } from './location-map-geocode.js';

const realFetch = globalThis.fetch;

function stubFetch(impl: () => Promise<unknown> | never): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return impl();
  }) as unknown as typeof globalThis.fetch;
  return urls;
}

describe('geocodeSearch', () => {
  afterEach(() => { globalThis.fetch = realFetch; });

  it('maps Nominatim hits to numbers', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => [
        { lat: '54.0924', lon: '12.0991', display_name: 'Rostock, Germany' },
      ],
    }));

    assert.deepEqual(await geocodeSearch('Rostock'), [
      { lat: 54.0924, lon: 12.0991, display_name: 'Rostock, Germany' },
    ]);
  });

  it('does not call the geocoder for an empty or whitespace query', async () => {
    const urls = stubFetch(async () => ({ ok: true, json: async () => [] }));

    assert.deepEqual(await geocodeSearch(''), []);
    assert.deepEqual(await geocodeSearch('   '), []);
    assert.deepEqual(urls, [], 'no request should leave the browser');
  });

  it('url-encodes the query rather than splicing it in raw', async () => {
    const urls = stubFetch(async () => ({ ok: true, json: async () => [] }));

    await geocodeSearch('Berlin, Straße & Co');

    assert.ok(urls[0].includes(encodeURIComponent('Berlin, Straße & Co')), urls[0]);
  });

  it('resolves to [] on a non-ok response instead of throwing', async () => {
    stubFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }));

    assert.deepEqual(await geocodeSearch('anything'), []);
  });

  it('resolves to [] when the network is unreachable', async () => {
    stubFetch(() => { throw new TypeError('Failed to fetch'); });

    assert.deepEqual(await geocodeSearch('offline'), []);
  });

  it('resolves to [] when the response is not the JSON it expects', async () => {
    stubFetch(async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }));

    assert.deepEqual(await geocodeSearch('html error page'), []);
  });
});
