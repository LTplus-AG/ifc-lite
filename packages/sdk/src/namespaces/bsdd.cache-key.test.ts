/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lock-in test: `fetchClassInfo` and `fetchClassByUri` share one
 * `Map<string, ...>` cache keyed only by URI. The two methods disagree on
 * what that URI's cached entry means — `fetchClassInfo` always marks its
 * classProperties `isIfcStandard: true` (it only ever resolves IFC
 * dictionary classes), `fetchClassByUri` always marks them `false` (its own
 * doc: "Useful for non-IFC dictionaries"). Nothing in the cache key records
 * which method produced an entry, so whichever method is called FIRST for a
 * given URI silently answers every later call to the OTHER method for that
 * same URI, with the wrong `isIfcStandard` flag and no network request.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BsddNamespace } from './bsdd.js';

type FetchSpy = ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

function mockFetchOnceWith(status: number, body: unknown): FetchSpy {
  const spy = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: { get: () => null },
    json: async () => body,
  })) as unknown as FetchSpy;
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  return spy;
}

beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('BsddNamespace cache key collision between fetchClassByUri and fetchClassInfo', () => {
  it('does not serve fetchClassByUri\'s non-IFC-standard entry to a later fetchClassInfo for the same URI', async () => {
    const ns = new BsddNamespace();
    const uri = ns.ifcClassUri('IfcWall');

    // fetchClassByUri populates the cache first, for a caller resolving a
    // non-IFC dictionary class that happens to share this URI shape.
    mockFetchOnceWith(200, {
      uri,
      code: 'IfcWall',
      name: 'Wall',
      classProperties: [{ name: 'IsExternal', propertyUri: 'x', dataType: 'Boolean' }],
    });
    const byUri = await ns.fetchClassByUri(uri);
    expect(byUri?.classProperties[0]?.isIfcStandard).toBe(false);

    // fetchClassInfo('IfcWall') resolves to the exact same URI. Its contract
    // is IFC-standard properties (isIfcStandard: true) — it must not be
    // answered from the other method's cached entry.
    const info = await ns.fetchClassInfo('IfcWall');
    expect(info?.classProperties[0]?.isIfcStandard).toBe(true);
  });
});
