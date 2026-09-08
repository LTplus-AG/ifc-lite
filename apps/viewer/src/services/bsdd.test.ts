/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchClassInfo, searchRelatedClasses, bsddDataTypeLabel } from './bsdd.js';

/** Minimal Response-like stub covering only what fetchJson touches. */
function jsonResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

type FetchCall = { url: string };

describe('bsdd', () => {
  let calls: FetchCall[];
  let responder: (url: string) => Response;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      calls.push({ url: u });
      return responder(u);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('fetchClassInfo', () => {
    it('returns null when the API responds with an error status, instead of parsing the error body as success', async () => {
      responder = () => jsonResponse(false, 404, { uri: 'should-not-be-used', code: 'IfcBogus' });
      const result = await fetchClassInfo('IfcBogusType1');
      assert.equal(result, null);
    });

    it('maps a well-formed class response, including nested class properties', async () => {
      responder = (url) => {
        if (url.includes('/api/Class/v1')) {
          return jsonResponse(true, 200, {
            uri: 'https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcWall',
            code: 'IfcWall',
            name: 'Wall',
            definition: 'A vertical construction',
            classProperties: [
              {
                name: 'IsExternal',
                propertyUri: 'https://x/IsExternal',
                dataType: 'Boolean',
                propertySet: 'Pset_WallCommon',
              },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      };
      const result = await fetchClassInfo('IfcWall2');
      assert.ok(result);
      assert.equal(result.code, 'IfcWall');
      assert.equal(result.classProperties.length, 1);
      assert.equal(result.classProperties[0].name, 'IsExternal');
      assert.equal(result.classProperties[0].isIfcStandard, true);
    });

    it('returns null (not a thrown parse error) for a malformed payload missing all expected fields', async () => {
      responder = () => jsonResponse(true, 200, null as unknown as Record<string, unknown>);
      // A malformed payload of `null` makes `raw.classProperties` throw inside
      // mapClassResponse (reading a property of null); fetchClassInfo's outer
      // try/catch must convert that into a null return, not an unhandled throw.
      const result = await fetchClassInfo('IfcBogusType2');
      assert.equal(result, null);
    });

    it('URL-encodes an IFC type name containing special characters', async () => {
      responder = () => jsonResponse(true, 200, { uri: 'u', code: 'X', name: 'X', classProperties: [] });
      await fetchClassInfo('Ifc Weird&Type/Name');
      assert.ok(calls.length > 0);
      const url = calls[0].url;
      assert.ok(!url.includes('Ifc Weird&Type/Name'), `raw type name leaked unencoded into ${url}`);
      assert.ok(url.includes(encodeURIComponent('Ifc Weird&Type/Name')));
    });

    it('caches a successful lookup and does not re-fetch within the TTL', async () => {
      let fetchCount = 0;
      responder = () => {
        fetchCount += 1;
        return jsonResponse(true, 200, { uri: 'u', code: 'IfcSlab', name: 'Slab', classProperties: [{ name: 'P', propertyUri: 'u/p' }] });
      };
      const first = await fetchClassInfo('IfcSlabCached');
      const second = await fetchClassInfo('IfcSlabCached');
      assert.ok(first);
      assert.ok(second);
      assert.equal(fetchCount, 1, 'second call should be served from cache, not re-fetched');
    });
  });

  describe('searchRelatedClasses', () => {
    it('returns an empty array (not a throw) when the API errors', async () => {
      responder = () => jsonResponse(false, 500, {});
      const result = await searchRelatedClasses('IfcDoor');
      assert.deepStrictEqual(result, []);
    });

    it('URL-encodes the search text and related-entities filter', async () => {
      responder = () => jsonResponse(true, 200, { classes: [] });
      await searchRelatedClasses('Ifc Weird&Type/Name');
      assert.ok(calls.length > 0);
      const url = calls[0].url;
      assert.ok(!url.includes('Ifc Weird&Type/Name'), `raw type name leaked unencoded into ${url}`);
      const encoded = encodeURIComponent('Ifc Weird&Type/Name');
      assert.ok(url.includes(`SearchText=${encoded}`), `SearchText not encoded in ${url}`);
      assert.ok(url.includes(`RelatedIfcEntities=${encoded}`), `RelatedIfcEntities not encoded in ${url}`);
    });

    it('maps search results defensively even when fields are missing', async () => {
      responder = () => jsonResponse(true, 200, { classes: [{ name: 'Door' }] });
      const result = await searchRelatedClasses('IfcDoor');
      assert.equal(result.length, 1);
      assert.equal(result[0].name, 'Door');
      assert.equal(result[0].code, 'Door');
      assert.equal(result[0].uri, '');
    });
  });

  describe('bsddDataTypeLabel', () => {
    it('normalizes known bSDD data types case-insensitively', () => {
      assert.equal(bsddDataTypeLabel('boolean'), 'Boolean');
      assert.equal(bsddDataTypeLabel('REAL'), 'Real');
      assert.equal(bsddDataTypeLabel('Number'), 'Real');
      assert.equal(bsddDataTypeLabel('integer'), 'Integer');
      assert.equal(bsddDataTypeLabel('character'), 'String');
    });

    it('passes through an unrecognized data type unchanged', () => {
      assert.equal(bsddDataTypeLabel('Enumeration'), 'Enumeration');
    });

    it('defaults a null/absent data type to "String"', () => {
      assert.equal(bsddDataTypeLabel(null), 'String');
    });
  });
});
