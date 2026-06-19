/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverDictionaries,
  fetchClassInfoForDictionary,
  searchRelatedClasses,
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

function searchRoute(ifcType: string, classes: Array<Record<string, unknown>>): Route {
  return {
    match: (url) => url.includes('/Class/Search/v1') && url.includes(`RelatedIfcEntities=${ifcType}`),
    body: { classes },
  };
}

function classRoute(classUri: string, classProperties: Array<Record<string, unknown>>): Route {
  const needle = encodeURIComponent(classUri);
  return {
    match: (url) => url.includes('/Class/v1?') && url.includes(needle),
    body: { uri: classUri, name: classUri, classProperties },
  };
}

describe('searchRelatedClasses', () => {
  it('maps the dictionaryName field from the API', async () => {
    routes = [
      searchRoute('IfcWallS', [
        {
          uri: 'https://x/uri/myco/d/1/class/W',
          name: 'Wall',
          referenceCode: 'W',
          dictionaryUri: 'https://x/uri/myco/d/1',
          dictionaryName: 'MyCo Dictionary',
        },
      ]),
    ];
    const results = await searchRelatedClasses('IfcWallS');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].dictionaryName, 'MyCo Dictionary');
    assert.strictEqual(results[0].code, 'W');
  });
});

describe('discoverDictionaries', () => {
  it('lists IFC first, drops the IFC dict from related results, dedups + sorts the rest', async () => {
    const myco = 'https://x/uri/myco/d/1';
    const uni = 'https://x/uri/nbs/uniclass2015/1';
    routes = [
      searchRoute('IfcWallD', [
        // IFC dict entry must be filtered out (IFC is the implicit default)
        { uri: `${IFC_DICTIONARY.uri}/class/IfcWallD`, dictionaryUri: IFC_DICTIONARY.uri, dictionaryName: 'IFC' },
        { uri: `${uni}/class/EF_25`, dictionaryUri: uni, dictionaryName: 'Uniclass 2015' },
        // MyCo appears twice — must dedup to a single option
        { uri: `${myco}/class/A`, dictionaryUri: myco, dictionaryName: 'MyCo Dictionary' },
        { uri: `${myco}/class/B`, dictionaryUri: myco, dictionaryName: 'MyCo Dictionary' },
      ]),
    ];

    const dicts = await discoverDictionaries('IfcWallD');
    assert.deepStrictEqual(
      dicts.map((d) => d.name),
      [IFC_DICTIONARY.name, 'MyCo Dictionary', 'Uniclass 2015'],
    );
    assert.strictEqual(dicts[0].uri, IFC_DICTIONARY.uri);
  });

  it('always returns at least the IFC dictionary', async () => {
    routes = [searchRoute('IfcWallE', [])];
    const dicts = await discoverDictionaries('IfcWallE');
    assert.deepStrictEqual(dicts, [IFC_DICTIONARY]);
  });
});

describe('fetchClassInfoForDictionary', () => {
  it('merges properties across a dictionary\'s related classes, deduped by pset:name', async () => {
    const myco = 'https://x/uri/myco/dM/1';
    const classA = `${myco}/class/A`;
    const classB = `${myco}/class/B`;
    routes = [
      searchRoute('IfcWallM', [
        { uri: classA, dictionaryUri: myco, dictionaryName: 'MyCo' },
        { uri: classB, dictionaryUri: myco, dictionaryName: 'MyCo' },
      ]),
      classRoute(classA, [
        { name: 'P1', propertySet: 'Pset_X', dataType: 'String' },
        { name: 'P2', propertySet: 'Pset_X', dataType: 'Real' },
      ]),
      classRoute(classB, [
        // P1/Pset_X duplicates classA — must collapse to one
        { name: 'P1', propertySet: 'Pset_X', dataType: 'String' },
        { name: 'P3', propertySet: 'Pset_Y', dataType: 'Boolean' },
      ]),
    ];

    const info = await fetchClassInfoForDictionary('IfcWallM', myco);
    assert.ok(info, 'expected merged class info');
    assert.deepStrictEqual(
      info!.classProperties.map((p) => `${p.propertySet}:${p.name}`),
      ['Pset_X:P1', 'Pset_X:P2', 'Pset_Y:P3'],
    );
    // Non-IFC properties must not be flagged as IFC-standard.
    assert.ok(info!.classProperties.every((p) => p.isIfcStandard === false));
  });

  it('returns null when the dictionary has no related class for the type', async () => {
    routes = [searchRoute('IfcWallN', [])];
    const info = await fetchClassInfoForDictionary('IfcWallN', 'https://x/uri/empty/d/1');
    assert.strictEqual(info, null);
  });

  it('delegates to the IFC name path when the IFC dictionary is selected', async () => {
    const ifcUri = `${IFC_DICTIONARY.uri}/class/IfcWallI`;
    routes = [
      classRoute(ifcUri, [
        { name: 'IsExternal', propertySet: 'Pset_WallCommon', dataType: 'Boolean' },
      ]),
    ];
    const info = await fetchClassInfoForDictionary('IfcWallI', IFC_DICTIONARY.uri);
    assert.ok(info, 'expected IFC class info');
    assert.strictEqual(info!.classProperties.length, 1);
    assert.strictEqual(info!.classProperties[0].name, 'IsExternal');
    // IFC-path properties are flagged as standard.
    assert.strictEqual(info!.classProperties[0].isIfcStandard, true);
  });
});
