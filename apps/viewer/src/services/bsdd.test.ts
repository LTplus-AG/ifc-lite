/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchAllDictionaries,
  listDictionaryClasses,
  searchDictionaryClasses,
  searchRelatedClasses,
  fetchClassByUri,
  IFC_DICTIONARY,
} from './bsdd.js';

// ---------------------------------------------------------------------------
// Minimal fetch stub. The bSDD service only reads `res.ok` and `res.json()`,
// so a route table keyed on URL substrings is enough to drive it.
// ---------------------------------------------------------------------------

interface Route {
  match: (url: string) => boolean;
  body: Record<string, unknown>;
}

let routes: Route[] = [];
const realFetch = globalThis.fetch;

function installFetch() {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const route = routes.find((r) => r.match(url));
    if (!route) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => route.body } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  routes = [];
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('searchRelatedClasses', () => {
  it('maps the dictionaryName + reference code from the API', async () => {
    routes = [
      {
        match: (url) => url.includes('/Class/Search/v1') && url.includes('RelatedIfcEntities=IfcWallS'),
        body: {
          classes: [
            {
              uri: 'https://x/uri/myco/d/1/class/W',
              name: 'Wall',
              referenceCode: 'W',
              dictionaryUri: 'https://x/uri/myco/d/1',
              dictionaryName: 'MyCo Dictionary',
            },
          ],
        },
      },
    ];
    const results = await searchRelatedClasses('IfcWallS');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].dictionaryName, 'MyCo Dictionary');
    assert.strictEqual(results[0].code, 'W');
  });
});

describe('searchDictionaryClasses', () => {
  it('free-text searches within a single dictionary and maps results', async () => {
    const dict = 'https://x/uri/etim/etim/10.1';
    routes = [
      {
        // Must scope to the dictionary and carry the query text
        match: (url) =>
          url.includes('/Class/Search/v1') &&
          url.includes(`DictionaryUris=${encodeURIComponent(dict)}`) &&
          url.includes('SearchText=cable'),
        body: {
          classes: [
            {
              uri: `${dict}/class/EC000019`,
              referenceCode: 'EC000019',
              name: 'Coaxial cable',
              dictionaryUri: dict,
              dictionaryName: 'ETIM 10.1',
            },
          ],
        },
      },
    ];
    const res = await searchDictionaryClasses(dict, 'cable');
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].code, 'EC000019');
    assert.strictEqual(res[0].name, 'Coaxial cable');
  });

  it('returns [] on API failure', async () => {
    routes = []; // every request 404s
    const res = await searchDictionaryClasses('https://x/uri/none/1', 'q');
    assert.deepStrictEqual(res, []);
  });
});

describe('listDictionaryClasses', () => {
  it('paginates a dictionary\'s classes and reports the total', async () => {
    const dict = 'https://x/uri/etim/etim/10.1';
    routes = [
      {
        match: (url) =>
          url.includes('/Dictionary/v1/Classes') &&
          url.includes(`Uri=${encodeURIComponent(dict)}`) &&
          url.includes('Offset=50'),
        body: {
          // the list endpoint omits dictionaryUri per class — service folds it in
          classes: [
            { uri: `${dict}/class/EC000051`, code: 'EC000051', name: 'Cable tray' },
          ],
          classesTotalCount: 5799,
          classesOffset: 50,
        },
      },
    ];
    const page = await listDictionaryClasses(dict, 50, 50);
    assert.strictEqual(page.total, 5799);
    assert.strictEqual(page.offset, 50);
    assert.strictEqual(page.classes.length, 1);
    assert.strictEqual(page.classes[0].code, 'EC000051');
    assert.strictEqual(page.classes[0].dictionaryUri, dict);
  });

  it('returns an empty page on API failure', async () => {
    routes = [];
    const page = await listDictionaryClasses('https://x/uri/none/1', 0, 50);
    assert.deepStrictEqual(page, { classes: [], total: 0, offset: 0 });
  });
});

describe('fetchAllDictionaries', () => {
  it('pins IFC first, drops a duplicate IFC entry, and sorts the rest by name+version', async () => {
    routes = [
      {
        match: (url) => url.includes('/Dictionary/v1'),
        body: {
          dictionaries: [
            // duplicate of the pinned IFC dictionary — must be dropped
            { uri: IFC_DICTIONARY.uri, name: 'IFC', version: '4.3' },
            { uri: 'https://x/uri/nbs/uniclass2015/1', name: 'Uniclass 2015' },
            { uri: 'https://x/uri/etim/etim/10.1', name: 'ETIM', version: '10.1' },
          ],
        },
      },
    ];
    const dicts = await fetchAllDictionaries();
    assert.strictEqual(dicts[0].uri, IFC_DICTIONARY.uri);
    assert.deepStrictEqual(
      dicts.map((d) => d.name),
      [IFC_DICTIONARY.name, 'ETIM 10.1', 'Uniclass 2015'],
    );
  });
});

describe('fetchClassByUri', () => {
  it('maps a non-IFC class\'s properties (not flagged IFC-standard)', async () => {
    const uri = 'https://x/uri/etim/etim/10.1/class/EC000770';
    routes = [
      {
        match: (url) => url.includes('/Class/v1?') && url.includes(encodeURIComponent(uri)),
        body: {
          uri,
          name: 'Separation plate',
          classProperties: [
            { name: 'Material', propertySet: 'Material', dataType: 'String' },
            { name: 'Height', propertySet: 'Measurements', dataType: 'Real' },
          ],
        },
      },
    ];
    const info = await fetchClassByUri(uri);
    assert.ok(info, 'expected class info');
    assert.strictEqual(info!.classProperties.length, 2);
    assert.ok(info!.classProperties.every((p) => p.isIfcStandard === false));
  });
});
