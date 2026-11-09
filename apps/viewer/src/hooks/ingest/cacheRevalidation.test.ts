/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * L9: a served cache hit whose source changed reloads it, unless the user has
 * started any other load meanwhile, from any loader instance. The identity
 * pass is held so the newer load starts while revalidation waits on it.
 */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { getViewerStoreApi } from '@/store';
import { installModelLoadCanceller, watchLoadSupersession } from '../modelLoadCanceller.js';
import { revalidateServedCache } from './cacheRevalidation.js';

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  getViewerStoreApi().getState().setActiveLoadCanceller(null);
});

function staleHit() {
  let resolveIdentity!: (hash: string) => void;
  const identity = new Promise<string | undefined>((resolve) => { resolveIdentity = resolve; });
  const hit = {
    file: new File(['ISO-10303-21;'], 'tower.ifc'),
    target: { kind: 'primary' as const },
    identity,
    cacheKey: 'tower-key',
    expectedHash: 'hash-at-write',
    supersession: watchLoadSupersession('any'),
  };
  return { hit, sourceChanged: () => resolveIdentity('hash-now') };
}

it('reloads a hit whose source changed when nothing else started', async () => {
  const { hit, sourceChanged } = staleHit();
  const reloads: string[] = [];
  const done = revalidateServedCache(hit, { reload: async (file) => { reloads.push(file.name); } });
  sourceChanged();
  await done;
  assert.deepEqual(reloads, ['tower.ifc']);
});

for (const kind of ['primary', 'federated'] as const) {
  it(`does not reload once the user started a ${kind} load meanwhile (L9)`, async () => {
    const { hit, sourceChanged } = staleHit();
    const reloads: string[] = [];
    const done = revalidateServedCache(hit, { reload: async (file) => { reloads.push(file.name); } });
    releases.push(installModelLoadCanceller(kind, () => {}));
    sourceChanged();
    await done;
    assert.deepEqual(reloads, [], 'the user is not yanked off the load they started');
  });
}
