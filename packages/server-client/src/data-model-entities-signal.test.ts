/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `dataModelEntities: 'rooted'` (issue #6034) selects a SEPARATE server cache
 * entry for the data model. The parse call, the cache check that decides
 * whether to skip the upload, and the data-model fetch must all name the same
 * one: a rooted parse writes only the rooted table, so a fetch that forgets
 * the option asks for an entry nobody wrote.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IfcServerClient } from './client.js';

function recordUrls(status = 404): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(null, { status });
    })
  );
  return urls;
}

const client = () => new IfcServerClient({ baseUrl: 'https://example.invalid' });
const file = () => new File([new Uint8Array([1, 2, 3])], 'x.ifc');
const ROOTED = 'data_model_entities=rooted';

/** The URLs of every endpoint whose answer depends on the data-model entry. */
const dataModelFamily = (urls: string[]) =>
  urls.filter(
    (u) =>
      /\/api\/v1\/parse\/parquet(\?|$|-stream|\/optimized)/.test(u) ||
      u.includes('/api/v1/cache/check/') ||
      u.includes('/api/v1/parse/data-model/')
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dataModelEntities signal (#6034)', () => {
  it('is sent on every data-model endpoint each parse flow touches', async () => {
    const urls = recordUrls();
    const options = { dataModelEntities: 'rooted' } as const;
    await client().parseParquet(file(), options).catch(() => {});
    await client().parseParquetOptimized(file(), options).catch(() => {});
    await client()
      .parseParquetStream(file(), () => {}, options)
      .catch(() => {});
    const family = dataModelFamily(urls);
    // cache check + flat upload, optimized upload, stream probe + upload.
    expect(family.length).toBe(5);
    for (const url of family) {
      expect(url, `${url} must name the rooted entry`).toContain(ROOTED);
    }
  });

  it('is absent by default, so a default request URL is unchanged', async () => {
    const urls = recordUrls();
    await client().parseParquet(file()).catch(() => {});
    await client().parseParquetOptimized(file(), { dataModelEntities: 'all' }).catch(() => {});
    await client().fetchDataModel('k-default');
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain('data_model_entities');
    }
  });

  it('fetchDataModel asks for the entry the parse options name', async () => {
    const urls = recordUrls();
    const parseOptions = { tessellationQuality: 'high', dataModelEntities: 'rooted' } as const;
    // The parse call's own options object is accepted as-is.
    expect(await client().fetchDataModel('k-default', parseOptions)).toBeNull();
    expect(urls).toEqual([`https://example.invalid/api/v1/parse/data-model/k-default?${ROOTED}`]);
  });

  it('keeps the numeric maxRetries form, and honours maxRetries in the object form', async () => {
    let urls = recordUrls(202);
    expect(await client().fetchDataModel('k', 1)).toBeNull();
    expect(urls).toEqual(['https://example.invalid/api/v1/parse/data-model/k']);

    urls = recordUrls(202);
    expect(await client().fetchDataModel('k', { maxRetries: 2, dataModelEntities: 'rooted' })).toBeNull();
    expect(urls).toEqual([
      `https://example.invalid/api/v1/parse/data-model/k?${ROOTED}`,
      `https://example.invalid/api/v1/parse/data-model/k?${ROOTED}`,
    ]);
  });
});
