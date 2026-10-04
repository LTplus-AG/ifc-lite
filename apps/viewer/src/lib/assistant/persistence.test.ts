/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { captureEvidence } from './evidence';
import { decodeConversation, assistantContent, type SavedConversation } from './persistence';
import { createContentLibrary, initialContentStatus } from '../storage/content-library';
import { contentTransaction, transactionDone, readContentRows } from '../storage/content-database';
import { createContentBackup, parseContentBackup, importContentBackup } from '../storage/content-backup';
import { openConversation } from './library';
import { useAssistant, cancelAssistant } from './conversation';
import { sendAssistant } from './request';

function conversation(): SavedConversation {
  const snapshot = captureEvidence('clash');
  const result = decodeConversation({ version: 1, id: snapshot.id, name: 'Coordination review', savedAt: new Date().toISOString(),
    model: 'openai/gpt-free', evidence: snapshot,
    messages: [{ role: 'user', content: 'Explain scope' }, { role: 'assistant', content: 'No scan results are included.', model: 'openai/gpt-free' }] });
  assert.ok(result);
  return result;
}
function library() {
  let entries: SavedConversation[] = [], status = initialContentStatus();
  return { ...createContentLibrary(assistantContent, () => entries, (next, state) => { entries = next; status = state; }),
    entries: () => entries, status: () => status };
}
beforeEach(async () => {
  const tx = await contentTransaction(['items', 'migrations', 'recovery'], 'readwrite');
  const done = transactionDone(tx);
  for (const name of ['items', 'migrations', 'recovery']) tx.objectStore(name).clear();
  await done;
  localStorage.clear();
});
afterEach(() => cancelAssistant());

// #6820: portable evidence never revives transient ownership/freshness objects.
test('portable decoding rejects malformed turns and mismatched evidence and strips runtime fields', () => {
  const entry = conversation();
  assert.equal('sourceIdentity' in entry.evidence, false);
  assert.equal('contextStamp' in entry.evidence, false);
  assert.equal(decodeConversation({ ...entry, messages: [{ role: 'assistant', content: 'forged completed turn' }] }), null);
  assert.equal(decodeConversation({ ...entry, evidence: { ...entry.evidence, totalRows: 123 } }), null);
  assert.equal(decodeConversation({ ...entry, messages: [...entry.messages, { role: 'user', content: 'unfinished' }] }), null);
  assert.equal(decodeConversation({ ...entry, name: 'x'.repeat(201) }), null);
});

test('reload recovers completed turns, while concurrent tabs retain conflicts without replacing evidence', async () => {
  const entry = conversation(), first = library();
  assert.equal(await first.put(entry.id, entry), true);
  const reopened = library(), otherTab = library();
  await Promise.all([reopened.initialize(), otherTab.initialize()]);
  assert.deepEqual(reopened.entries()[0], entry);
  assert.equal(await reopened.put(entry.id, { ...entry, messages: [...entry.messages,
    { role: 'user', content: 'Next question' }, { role: 'assistant', content: 'Next answer', model: 'openai/gpt-free' }] }), true);
  assert.equal(await otherTab.put(entry.id, { ...entry, name: 'Other tab draft' }), false);
  assert.equal(otherTab.status().items[entry.id], 'conflict');
  assert.equal(otherTab.entries()[0].name, 'Other tab draft');
  assert.equal((await readContentRows('assistant'))[0].revision, 2);
  assert.equal(await otherTab.put(entry.id, null), false, 'stale delete cannot remove newer saved work');
});

test('quota refusal preserves an exportable draft and retry commits it without losing turns', async () => {
  const content = library(), entry = conversation();
  await content.initialize();
  const native = IDBDatabase.prototype.transaction;
  const refused = mock.method(IDBDatabase.prototype, 'transaction', function(this: IDBDatabase,
    stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
    if (mode === 'readwrite' && stores === 'items') throw new DOMException('Quota exhausted', 'QuotaExceededError');
    return native.call(this, stores, mode, options);
  });
  try {
    assert.equal(await content.put(entry.id, entry), false);
    assert.equal(content.status().items[entry.id], 'quota');
    const backup = parseContentBackup(JSON.stringify(createContentBackup({ validation: [], comparison: [], document: [], assistant: content.entries() })));
    assert.deepEqual(backup.libraries.assistant?.[0].messages, entry.messages);
  } finally { refused.mock.restore(); }
  assert.equal(await content.retry(), true);
  assert.equal(content.status().items[entry.id], 'saved');
});

test('backups preserve older libraries, deduplicate assistant imports and fork conflicting identities', async () => {
  const entry = conversation();
  const old = parseContentBackup(JSON.stringify(createContentBackup({ validation: [], comparison: [], document: [] })));
  assert.equal(old.libraries.assistant, undefined);
  const backup = createContentBackup({ validation: [], comparison: [], document: [], assistant: [entry] });
  assert.equal(await importContentBackup(backup), 1);
  assert.equal(await importContentBackup(backup), 0);
  const conflicting = createContentBackup({ ...backup.libraries, assistant: [{ ...entry, name: 'Different imported review',
    messages: [{ role: 'user', content: 'Different question' }, { role: 'assistant', content: 'Different evidence explanation', model: 'openai/gpt-free' }] }] });
  assert.equal(await importContentBackup(conflicting), 1);
  const rows = await readContentRows('assistant');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.deepEqual(rows[0].payload, entry);
});

test('opening saved evidence never sends against current models before explicit refresh', async () => {
  const entry = conversation();
  openConversation(entry);
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('must not send archived evidence'); };
  try {
    assert.equal(await sendAssistant('Continue', entry.model, '/api/chat'), false);
    assert.equal(calls, 0);
    assert.equal(useAssistant.getState().snapshot, null);
    assert.equal(useAssistant.getState().archived?.id, entry.id);
    assert.deepEqual(useAssistant.getState().messages, entry.messages);
  } finally { globalThis.fetch = original; }
});
