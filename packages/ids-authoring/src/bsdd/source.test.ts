/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The HTTP bSDD source against recorded API v1 responses (IDS-069). Offline: nothing reaches the network. */

import { describe, expect, it } from 'vitest';
import { DEMO, DEMO_V2, demoClass, demoProp, demoSource, replayFetch } from '../../test/bsdd/replay.js';
import { dictionaryUriOf, readClass, readClassProperty } from './contract.js';
import { createHttpBsddSource } from './http-source.js';
import { BsddHttpError } from './types.js';

describe('bSDD API v1 contracts', () => {
  it('reads a class with its properties, tree links and replacements', async () => {
    const cls = await demoSource().getClass(demoClass('WAL-EXT'));
    expect(cls).toMatchObject({
      uri: demoClass('WAL-EXT'),
      code: 'WAL-EXT',
      status: 'active',
      dictionaryUri: DEMO,
      relatedIfcEntityNames: ['IfcWall', 'IfcWallSOLIDWALL'],
      parentClass: { uri: demoClass('WAL'), code: 'WAL' },
    });
    const u = cls?.properties.find((p) => p.code === 'ThermalTransmittance');
    expect(u).toMatchObject({ dataType: 'Real', dimension: '0 1 -3 0 -1 0 0', units: ['W/(m2·K)'], maxInclusive: 0.3, isRequired: true, propertySet: 'Demo_Wall' });
    // The property definition URI wins over the class-property URI.
    expect(cls?.properties.find((p) => p.code === 'IsExternal')?.uri).toBe('https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/prop/IsExternal');
  });

  it('degrades malformed input to absent fields, never throws', () => {
    expect(readClass(null)).toBeUndefined();
    expect(readClass({ code: 'X' })).toBeUndefined();
    const odd = readClass({ uri: `${DEMO}/class/X`, code: 'X', classProperties: [{ name: 7 }, { propertyCode: 'A', minInclusive: 'nan', allowedValues: [{}, { value: 'v' }] }], relatedIfcEntityNames: ['IfcWall', 3] });
    expect(odd).toMatchObject({ dictionaryUri: DEMO, status: 'unknown', relatedIfcEntityNames: ['IfcWall'] });
    expect(odd?.properties).toEqual([{ code: 'A', name: 'A', allowedValues: [{ code: 'v', value: 'v' }] }]);
    expect(readClassProperty({ propertyCode: 'B', minInclusive: '5' })?.minInclusive).toBe(5);
    expect(dictionaryUriOf(`${DEMO}/prop/FireRating`)).toBe(DEMO);
    expect(dictionaryUriOf('https://example.org/x')).toBeUndefined();
  });
});

describe('createHttpBsddSource (recorded responses)', () => {
  it('lists dictionaries with their licence and status', async () => {
    const dicts = await demoSource().listDictionaries();
    expect(dicts.map((d) => [d.uri, d.version, d.status, d.license])).toEqual([
      [DEMO, '1.0', 'active', 'CC0-1.0'],
      [DEMO_V2, '2.0', 'preview', 'CC0-1.0'],
    ]);
  });

  it('lists a dictionary’s classes flat, with parent codes for the tree', async () => {
    const rows = await demoSource().listClasses(DEMO);
    expect(rows.map((r) => [r.code, r.parentClassCode ?? null, r.dictionaryName])).toEqual([
      ['WAL', null, 'Demo Elements'],
      ['WAL-EXT', 'WAL', 'Demo Elements'],
      ['WAL-INT', 'WAL', 'Demo Elements'],
      ['WAL-PRT', 'WAL', 'Demo Elements'],
      ['DOR', null, 'Demo Elements'],
      ['SHD', null, 'Demo Elements'],
    ]);
  });

  it('passes the picker filters to the search endpoint', async () => {
    const replay = replayFetch();
    const page = await demoSource(replay).searchClasses({ text: 'wall', dictionaryUris: [DEMO], relatedIfcEntity: 'IfcWall' });
    expect(page.total).toBe(4);
    expect(replay.requests[0]).toContain('DictionaryUris=' + encodeURIComponent(DEMO));
    expect(replay.requests[0]).toContain('RelatedIfcEntities=IfcWall');
  });

  it('maps 404 to null and other failures to BsddHttpError with Retry-After', async () => {
    expect(await demoSource().getClass(demoClass('GONE'))).toBeNull();
    const limited = createHttpBsddSource({
      fetch: async () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }),
    });
    const err = await limited.getClass(demoClass('WAL')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BsddHttpError);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 7 });
  });

  it('aborts a request that exceeds the timeout', async () => {
    const hanging = createHttpBsddSource({
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    });
    await expect(hanging.getClass(demoClass('WAL'))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves class, property, class-property and dictionary URIs for URI health', async () => {
    const src = demoSource();
    expect(await src.resolveUri(demoClass('WAL-PRT'))).toEqual({
      uri: demoClass('WAL-PRT'),
      state: 'inactive',
      kind: 'class',
      dictionaryName: 'Demo Elements',
      replacedBy: [demoClass('WAL-INT')],
      checkedAt: 1_700_000_000_000,
    });
    expect(await src.resolveUri(demoProp('FireRating'))).toMatchObject({ state: 'active', kind: 'property', allowedValues: ['EI30', 'EI60', 'EI90'] });
    expect(await src.resolveUri(demoProp('Thickness'))).toMatchObject({ state: 'inactive', replacedBy: [demoProp('NominalThickness')] });
    expect(await src.resolveUri(demoProp('Nope'))).toMatchObject({ state: 'notFound', kind: 'property' });
    expect(await src.resolveUri(demoClass('GONE'))).toMatchObject({ state: 'notFound', kind: 'class' });
    expect(await src.resolveUri(`${demoClass('WAL-EXT')}/prop/IsExternal`)).toMatchObject({ state: 'active', kind: 'property' });
    expect(await src.resolveUri(DEMO)).toMatchObject({ state: 'active', kind: 'dictionary', dictionaryName: 'Demo Elements' });
  });
});
