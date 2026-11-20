/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudioDocument } from '@ifc-lite/ids-authoring';
import { createContentBackup, encodeContentBackup, importContentBackup, parseContentBackup } from '@/lib/storage/content-backup';
import { readContentRows } from '@/lib/storage/content-database';
import { wallFixture } from '@/test/ids-studio-fixture';
import { decodeIdsStudioDraft, encodeIdsStudioDraft, IDS_DRAFT_MAX_MIB } from './draft-codec.js';
import { readIdsDraftDocument } from './draft-document.js';
import { idsStudioDraftLibrary } from './draft-library.js';
import { createIdsDraftAutosave, IDS_DRAFT_DEBOUNCE_MS, restoreIdsDraft, restoreInitialIdsDraft } from './draft-session.js';

test('#10585 draft codec preserves IDS rules, stable IDs and Studio metadata through backup and v1 migration', async () => {
  const { doc, propertyId } = await wallFixture();
  const withComments = { ...doc, meta: { ...doc.meta, sources: { [propertyId]: [{ docRef: 'brief', kind: 'text' as const, quote: 'Keep this' }] } } };
  const encoded = encodeIdsStudioDraft('fire', withComments, 42);
  assert.ok(encoded.ok);
  const draft = decodeIdsStudioDraft(JSON.parse(JSON.stringify(encoded.draft)));
  assert.ok(draft);
  assert.deepEqual(readIdsDraftDocument(draft), withComments);
  const migrated = decodeIdsStudioDraft({ ...draft, version: 1, document: withComments });
  assert.deepEqual(migrated, draft);
  assert.equal(decodeIdsStudioDraft({ ...draft, version: 100 }), null);
  const backup = createContentBackup({ validation: [], document: [], comparison: [], idsStudioDrafts: [draft] });
  const parsed = parseContentBackup(JSON.stringify(encodeContentBackup(backup)));
  assert.equal(await importContentBackup(parsed), 1);
  assert.deepEqual((await readContentRows('idsStudioDrafts')).find(row => row.id === draft.id)?.payload, draft);
});

test('#10585 autosave debounces consecutive changes and refuses oversized UTF-8 snapshots', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = createStudioDocument({ title: 'Initial' });
  const stored: string[] = [];
  const errors: Array<string | null> = [];
  const save = createIdsDraftAutosave(async draft => { stored.push(draft.title); return true; }, (_id, error) => errors.push(error));
  save.schedule('size-test', doc);
  assert.equal(errors.at(-1), 'pending');
  context.mock.timers.tick(IDS_DRAFT_DEBOUNCE_MS - 1);
  save.schedule('size-test', { ...doc, ids: { ...doc.ids, info: { title: 'Latest' } } });
  context.mock.timers.tick(IDS_DRAFT_DEBOUNCE_MS - 1);
  assert.deepEqual(stored, []);
  context.mock.timers.tick(1);
  await save.flush('size-test');
  assert.deepEqual(stored, ['Latest']);
  assert.equal(errors.at(-1), null);
  const oversized = { ...doc, ids: { ...doc.ids, info: { title: 'Oversized', description: '漢'.repeat(IDS_DRAFT_MAX_MIB * 1024 * 512) } } };
  save.schedule('size-test', oversized);
  assert.equal(await save.flush('size-test'), false);
  assert.equal(errors.at(-1), 'tooLarge');
  assert.deepEqual(stored, ['Latest'], 'refusal keeps the previous durable document');
});

test('#10585 reopening restores a readable draft and leaves an intervening IDS open', async () => {
  const saved = encodeIdsStudioDraft('restore-test', createStudioDocument({ title: 'Recovered' }), 1);
  assert.ok(saved.ok);
  let revision = 0;
  let title = '';
  const unreadable = { ...saved.draft, id: 'damaged-test', savedAt: 2, document: '{' };
  assert.equal(await idsStudioDraftLibrary.put(unreadable.id, unreadable), true);
  const read = () => ({ revision, drafts: [saved.draft, unreadable] });
  const restore: Parameters<typeof restoreInitialIdsDraft>[2] = draft => restoreIdsDraft(draft, doc => {
    revision += 1;
    title = doc.ids.info.title;
  });
  await restoreInitialIdsDraft(async () => true, read, restore);
  assert.equal(title, 'Recovered');
  const damagedRow = (await readContentRows('idsStudioDrafts')).find(row => row.id === unreadable.id);
  assert.equal(decodeIdsStudioDraft(damagedRow?.payload)?.document, '{');
  revision = 0;
  const attempt = restoreInitialIdsDraft(async () => true, read, restore);
  revision = 1;
  title = 'Opened while loading';
  await attempt;
  assert.equal(title, 'Opened while loading');
  assert.equal(restore(saved.draft), true, 'an explicit restore still works');
  assert.equal(title, 'Recovered');
});
