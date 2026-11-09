/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * L9: a served cache hit whose source changed reloads it, unless the user has
 * started any other load meanwhile, from any loader instance. It then stands
 * down, and says so while the stale model is still shown (the cache entry is
 * gone, so a later open reads the current file). The identity pass is held so
 * the newer load starts while revalidation waits on it.
 */
import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { getViewerStoreApi } from '@/store';
import { toast } from '@/components/ui/toast';
import { fixtureModel } from '@/test/store-fixture.js';
import { installModelLoadCanceller, watchLoadSupersession } from '../modelLoadCanceller.js';
import { revalidateServedCache } from './cacheRevalidation.js';

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  getViewerStoreApi().getState().setActiveLoadCanceller(null);
  getViewerStoreApi().getState().clearAllModels();
  mock.restoreAll();
});

function staleHit() {
  let resolveIdentity!: (hash: string) => void;
  const identity = new Promise<string | undefined>((resolve) => { resolveIdentity = resolve; });
  const hit = {
    file: new File(['ISO-10303-21;'], 'tower.ifc'),
    target: { kind: 'primary' as const },
    modelId: 'tower',
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
  it(`does not reload once the user started a ${kind} load meanwhile, and says so while the stale model is shown (L9)`, async () => {
    getViewerStoreApi().getState().addModel(fixtureModel('tower'));
    const notices: string[] = [];
    mock.method(toast, 'info', (message: string) => { notices.push(message); });
    const { hit, sourceChanged } = staleHit();
    const reloads: string[] = [];
    const done = revalidateServedCache(hit, { reload: async (file) => { reloads.push(file.name); } });
    releases.push(installModelLoadCanceller(kind, () => {}));
    sourceChanged();
    await done;
    assert.deepEqual(reloads, [], 'the user is not yanked off the load they started');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /"tower\.ifc" changed since it was cached — reopen it/);
  });
}

it('stands down silently when the newer load already replaced the stale model (L9)', async () => {
  const notices: string[] = [];
  mock.method(toast, 'info', (message: string) => { notices.push(message); });
  const { hit, sourceChanged } = staleHit();
  const reloads: string[] = [];
  const done = revalidateServedCache(hit, { reload: async (file) => { reloads.push(file.name); } });
  releases.push(installModelLoadCanceller('primary', () => {})); // no 'tower' model is left in the scene
  sourceChanged();
  await done;
  assert.deepEqual(reloads, []);
  assert.deepEqual(notices, [], 'nothing stale is on screen to explain');
});
