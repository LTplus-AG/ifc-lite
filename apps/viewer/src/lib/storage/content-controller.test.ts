/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { createContentLibrary, initialContentStatus } from './content-library.js';
import { contentTransaction, readContentRows, transactionDone } from './content-database.js';
import type { ContentDefinition } from './content-migration.js';

interface Entry { id: string; name: string }
const definition: ContentDefinition<Entry> = {
  kind: 'document', legacyKey: 'content-controller-test',
  decode(value) {
    if (!value || typeof value !== 'object') return null;
    const entry = value as Record<string, unknown>;
    return typeof entry.id === 'string' && typeof entry.name === 'string'
      ? { id: entry.id, name: entry.name } : null;
  },
};
function library() {
  let entries: Entry[] = [];
  let status = initialContentStatus();
  return { ...createContentLibrary(definition, () => entries, (next, state) => { entries = next; status = state; }),
    entries: () => entries, status: () => status };
}
beforeEach(async () => {
  const tx = await contentTransaction(['items', 'migrations', 'recovery'], 'readwrite');
  const done = transactionDone(tx);
  for (const name of ['items', 'migrations', 'recovery']) tx.objectStore(name).clear();
  await done;
  localStorage.clear();
});

it('#6679 an unobserved ID keeps revision zero when another tab saves before draft hydration', async () => {
  const first = library(), second = library(), entry = { id: 'shared-id', name: 'Initial' };
  await Promise.all([first.initialize(), second.initialize()]);
  assert.equal(await first.put(entry.id, { ...entry, name: 'Other tab evidence' }), true);
  second.stage(entry.id, { ...entry, name: 'Unobserved draft' });
  await second.refresh();
  assert.equal(second.status().items[entry.id], 'conflict');
  assert.equal(await second.retry(), false);
  assert.equal(second.entries()[0].name, 'Unobserved draft');
  assert.deepEqual((await readContentRows('document'))[0].payload, { ...entry, name: 'Other tab evidence' });
});

it('#6679 restore never discards a draft created after its confirmation', async () => {
  const content = library(), entry = { id: 'draft-id', name: 'Initial' };
  assert.equal(await content.put(entry.id, entry), true);
  content.stage(entry.id, { ...entry, name: 'Previously confirmed draft' });
  const restoring = content.restore();
  content.stage(entry.id, { ...entry, name: 'Newer unconfirmed draft' });
  assert.equal(await restoring, false);
  assert.equal(content.entries()[0].name, 'Newer unconfirmed draft');
  assert.equal(await content.retry(), true);
  assert.deepEqual((await readContentRows('document'))[0].payload, { ...entry, name: 'Newer unconfirmed draft' });
});
