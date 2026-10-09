/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** URI health: cached (24 h), rate-limited checks against recorded bSDD responses (IDS-073). */

import { describe, expect, it } from 'vitest';
import { demoClass, demoProp, demoSource, replayFetch } from '../../test/bsdd/replay.js';
import { addFacet, eq, specDoc } from '../../test/gate-helpers.js';
import { apply } from '../reducer/apply.js';
import { BsddHttpError, type BsddSource } from './types.js';
import { checkUriHealth, collectDocUris, createBsddUriIndex, URI_HEALTH_TTL_MS } from './uri-health.js';

const T0 = 1_700_000_000_000;

describe('collectDocUris', () => {
  it('lists the bSDD URIs on facets, not other URIs', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const after = apply(doc, [
      addFacet(specId, { type: 'classification', system: eq('Demo Elements'), uri: demoClass('WAL') }),
      addFacet(specId, { type: 'material', value: eq('Concrete'), uri: 'https://example.org/materials/concrete' }),
      addFacet(specId, { type: 'property', propertySet: eq('Demo_Wall'), baseName: eq('FireRating'), uri: demoProp('FireRating') }),
    ]).doc;
    expect(collectDocUris(after).map((u) => [u.uri, u.facetType, u.specId])).toEqual([
      [demoClass('WAL'), 'classification', specId],
      [demoProp('FireRating'), 'property', specId],
    ]);
  });
});

describe('checkUriHealth', () => {
  it('resolves each URI once, pauses between requests, and serves fresh records from the index for 24 h', async () => {
    const replay = replayFetch();
    const index = createBsddUriIndex();
    const sleeps: number[] = [];
    let now = T0;
    const opts = { source: demoSource(replay, () => now), index, now: () => now, sleep: async (ms: number) => void sleeps.push(ms) };
    const uris = [demoClass('WAL'), demoClass('WAL-PRT'), demoProp('FireRating'), demoClass('WAL')];
    const first = await checkUriHealth(uris, opts);
    expect(first).toEqual({ checked: [demoClass('WAL'), demoClass('WAL-PRT'), demoProp('FireRating')], fresh: [], failed: [], deferred: [] });
    expect(sleeps).toEqual([200, 200]);
    expect(index.get(demoClass('WAL-PRT'))).toMatchObject({ state: 'inactive', replacedBy: [demoClass('WAL-INT')], dictionaryName: 'Demo Elements' });
    expect(index.get(demoProp('FireRating'))).toMatchObject({ allowedValues: ['EI30', 'EI60', 'EI90'], allowedLabels: ['EI 30', 'EI 60', 'EI 90'] });
    const requests = replay.requests.length;
    now = T0 + URI_HEALTH_TTL_MS - 1;
    expect((await checkUriHealth(uris, opts)).fresh).toHaveLength(3);
    expect(replay.requests.length).toBe(requests); // cached: no new request
    now = T0 + URI_HEALTH_TTL_MS;
    expect((await checkUriHealth([demoClass('WAL')], opts)).checked).toEqual([demoClass('WAL')]);
    expect(replay.requests.length).toBeGreaterThan(requests);
  });

  it('stops on a dead connection or a rate limit and defers the rest; records nothing for them', async () => {
    const index = createBsddUriIndex();
    const before = index.revision;
    const offline: BsddSource = { ...demoSource(), resolveUri: async () => Promise.reject(new TypeError('fetch failed')) };
    const r = await checkUriHealth([demoClass('WAL'), demoClass('DOR')], { source: offline, index, sleep: async () => {} });
    expect(r).toMatchObject({ stopped: 'offline', checked: [], deferred: [demoClass('WAL'), demoClass('DOR')] });
    expect(index.revision).toBe(before);
    let calls = 0;
    const limited: BsddSource = {
      ...demoSource(),
      resolveUri: async (uri) => {
        if (++calls === 2) throw new BsddHttpError(429, uri, 30);
        return demoSource().resolveUri(uri);
      },
    };
    const l = await checkUriHealth([demoClass('WAL'), demoClass('DOR'), demoClass('SHD')], { source: limited, index, sleep: async () => {} });
    expect(l).toMatchObject({ stopped: 'rateLimited', retryAfterSeconds: 30, checked: [demoClass('WAL')], deferred: [demoClass('DOR'), demoClass('SHD')] });
  });

  it('records other HTTP failures and carries on; honours the budget and an abort', async () => {
    const index = createBsddUriIndex();
    const flaky: BsddSource = {
      ...demoSource(),
      resolveUri: async (uri) => (uri.endsWith('/WAL') ? Promise.reject(new BsddHttpError(500, uri)) : demoSource().resolveUri(uri)),
    };
    const r = await checkUriHealth([demoClass('WAL'), demoClass('DOR')], { source: flaky, index, sleep: async () => {} });
    expect(r).toMatchObject({ failed: [{ uri: demoClass('WAL'), status: 500 }], checked: [demoClass('DOR')] });
    const b = await checkUriHealth([demoClass('SHD'), demoClass('WAL-INT')], { source: demoSource(), index: createBsddUriIndex(), sleep: async () => {}, maxChecks: 1 });
    expect(b).toMatchObject({ stopped: 'budget', checked: [demoClass('SHD')], deferred: [demoClass('WAL-INT')] });
    const ac = new AbortController();
    ac.abort();
    expect(await checkUriHealth([demoClass('SHD')], { source: demoSource(), index: createBsddUriIndex(), signal: ac.signal })).toMatchObject({ stopped: 'aborted' });
  });
});
