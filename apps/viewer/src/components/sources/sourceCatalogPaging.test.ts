/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage for the eager file sweep this PR introduced. `fetchAllFilePages`
 * replaced the viewer's manual "load more files" path, so nothing else now
 * bounds how many pages a folder listing walks -- the aggregation, the cursor
 * termination and the runaway ceiling are only exercised here.
 *
 * The ceiling case is the load-bearing one. `ListOptions.limit` is a "hint
 * only; providers clamp to whatever their API allows"
 * (`packages/plugin-api/src/types.ts`), so counting the guard in PAGES made it
 * fire on container size for a provider with a small clamp while never firing
 * for one that honours the hint. It counts items instead; the small-page test
 * below is what pins that, and it fails against a page-counted ceiling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { FileSourceProvider, PluginContext, SourceFile } from '@ifc-lite/plugin-api';
import { fetchAllFilePages } from './sourceCatalogPaging';

const ctx = {} as PluginContext;

function file(id: string): SourceFile {
  return { id, name: `${id}.ifc`, containerId: 'c', size: 1 } as unknown as SourceFile;
}

/**
 * Provider whose `listFiles` serves `pages` in order, handing out a cursor for
 * every page but the last. Records the cursors it was called with so cursor
 * threading is observable, not assumed.
 */
function providerOf(pages: SourceFile[][]): {
  provider: FileSourceProvider;
  calls: (string | undefined)[];
} {
  const calls: (string | undefined)[] = [];
  const provider = {
    listFiles: async (
      _c: PluginContext,
      _p: string,
      _container: string,
      _filter: unknown,
      opts: { cursor?: string },
    ) => {
      calls.push(opts.cursor);
      const idx = opts.cursor === undefined ? 0 : Number(opts.cursor);
      const isLast = idx >= pages.length - 1;
      return { items: pages[idx] ?? [], cursor: isLast ? undefined : String(idx + 1) };
    },
  } as unknown as FileSourceProvider;
  return { provider, calls };
}

const sweep = (provider: FileSourceProvider) =>
  fetchAllFilePages(provider, ctx, 'proj', 'container', new AbortController().signal);

describe('fetchAllFilePages', () => {
  it('returns a single cursorless page without asking for another', async () => {
    const { provider, calls } = providerOf([[file('a'), file('b')]]);
    const result = await sweep(provider);

    assert.deepEqual(
      result.items.map((f) => f.id),
      ['a', 'b'],
    );
    assert.equal(result.cursor, undefined);
    assert.deepEqual(calls, [undefined], 'a cursorless first page must end the sweep');
  });

  it('concatenates every page in order and threads each cursor through', async () => {
    const { provider, calls } = providerOf([[file('a')], [file('b')], [file('c')]]);
    const result = await sweep(provider);

    assert.deepEqual(
      result.items.map((f) => f.id),
      ['a', 'b', 'c'],
      'pages must be aggregated in provider order, not interleaved or deduped',
    );
    // `cursor: undefined` is the contract: the caller has everything, so the
    // viewer must not offer a "load more" it cannot service.
    assert.equal(result.cursor, undefined);
    assert.deepEqual(calls, [undefined, '1', '2'], 'each page must be fetched with the prior cursor');
  });

  it('sweeps a listing whose provider clamps to one item per page', async () => {
    // 600 single-item pages: past the old 500-PAGE ceiling, far short of the
    // item ceiling. A conforming provider is allowed to clamp `limit` this
    // hard, so this must succeed. Against a page-counted guard it throws and
    // the caller discards all 600 files.
    const pages = Array.from({ length: 600 }, (_, i) => [file(`f${i}`)]);
    const { provider } = providerOf(pages);

    const result = await sweep(provider);

    assert.equal(result.items.length, 600);
    assert.equal(result.items[599]?.id, 'f599');
    assert.equal(result.cursor, undefined);
  });

  it('throws rather than hanging when a provider mints cursors forever', async () => {
    // Never yields a cursorless page: the runaway the ceiling exists for.
    const provider = {
      listFiles: async (_c: PluginContext, _p: string, _container: string, _f: unknown, opts: { cursor?: string }) => {
        const n = opts.cursor === undefined ? 0 : Number(opts.cursor);
        return { items: [file(`f${n}`)], cursor: String(n + 1) };
      },
    } as unknown as FileSourceProvider;

    await assert.rejects(
      () => sweep(provider),
      /exceeded .* without finishing/,
      'an endless cursor chain must fail loudly, not loop',
    );
  });
});
