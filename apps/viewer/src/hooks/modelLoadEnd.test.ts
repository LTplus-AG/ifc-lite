/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';

/** Loaded at runtime so a build without the mark fails these assertions instead of failing to load (revert oracle). */
async function load() {
  const end = (await import('./modelLoadEnd.js').catch(() => null)) as Record<string, unknown> | null;
  assert.equal(typeof end?.subscribeModelLoadEnded, 'function', 'modelLoadEnd.ts must export subscribeModelLoadEnded');
  const canceller = await import('./modelLoadCanceller.js');
  return { subscribe: end!.subscribeModelLoadEnded as (l: (id: string) => void) => () => void, settle: canceller.settleOwnedLoadUi };
}

it('the loader\'s settle of a model\'s load UI marks that model\'s load as ended, after the load UI settled', async () => {
  const { subscribe, settle } = await load();
  const seen: string[] = [];
  const order: string[] = [];
  const unsubscribe = subscribe((id) => { seen.push(id); order.push('ended'); });
  try {
    settle(() => order.push('release'), null, 'model-1');
    assert.deepEqual(seen, ['model-1']);
    assert.deepEqual(order, ['release', 'ended'], 'the mark follows the release and the UI settle');
    settle(() => {}, null);
    assert.deepEqual(seen, ['model-1'], 'a settle without a model id (federated IFCX composition) marks nothing');
  } finally {
    unsubscribe();
  }
});
