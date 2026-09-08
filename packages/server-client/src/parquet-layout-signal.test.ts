/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared-shape flat Parquet layout is OPT-IN on the server (issue #3888):
 * it renders wrong on a client that predates it, and the flat wire has no
 * version byte such a client could fail loud on, so the server produces the
 * older layout unless the request says `parquet_layout=shared-shapes`.
 *
 * This version's decoder applies `rot0..rot8`, so it opts in — and it has to do
 * so on EVERY endpoint that touches the geometry cache, because the two layouts
 * are stored under separate keys. A cache check that forgets the signal reports
 * on the wrong entry: it would answer "cached" for a v5 blob and the client
 * would then skip the upload and fetch a layout it did not ask for, or answer
 * "not cached" for a file whose shared entry is sitting right there.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IfcServerClient } from './client.js';

/** Record every URL fetched, answering with something each caller can parse. */
function recordUrls(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(String(url));
      // 404 on the cache endpoints keeps every flow short: nothing decodes.
      return new Response(null, { status: 404 });
    })
  );
  return urls;
}

const client = () => new IfcServerClient({ baseUrl: 'https://example.invalid' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('flat Parquet layout signal', () => {
  const file = () => new File([new Uint8Array([1, 2, 3])], 'x.ifc');

  /** Every URL a flow touched that belongs to the flat-Parquet cache family. */
  const flatFamily = (urls: string[]) =>
    urls.filter(
      (u) =>
        /\/api\/v1\/parse\/parquet(\?|$|-stream)/.test(u) ||
        u.includes('/api/v1/cache/check/') ||
        u.includes('/api/v1/cache/geometry/')
    );

  it('is sent on every endpoint the flat parse flow touches', async () => {
    const urls = recordUrls();
    await client().parseParquet(file()).catch(() => {});
    const family = flatFamily(urls);
    expect(family.length).toBeGreaterThan(0);
    for (const url of family) {
      expect(url, `${url} must carry the layout signal`).toContain(
        'parquet_layout=shared-shapes'
      );
    }
  });

  it('is sent on every endpoint the streaming parse flow touches', async () => {
    const urls = recordUrls();
    await client()
      .parseParquetStream(file(), () => {})
      .catch(() => {});
    const family = flatFamily(urls);
    expect(family.length).toBeGreaterThan(0);
    for (const url of family) {
      expect(url, `${url} must carry the layout signal`).toContain(
        'parquet_layout=shared-shapes'
      );
    }
  });

  it('survives alongside another query parameter', async () => {
    const urls = recordUrls();
    await client()
      .parseParquet(file(), { tessellationQuality: 'high' })
      .catch(() => {});
    const [first] = flatFamily(urls);
    expect(first).toContain('parquet_layout=shared-shapes');
    expect(first).toContain('tessellation_quality=high');
  });

  it('is NOT sent to the optimized route, which has its own format and key', async () => {
    const urls = recordUrls();
    await client()
      .parseParquetOptimized(file())
      .catch(() => {});
    const optimized = urls.filter((u) => u.includes('/parse/parquet/optimized'));
    expect(optimized.length).toBeGreaterThan(0);
    for (const url of optimized) {
      expect(url).not.toContain('parquet_layout');
    }
  });
});
