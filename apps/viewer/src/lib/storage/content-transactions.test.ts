/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { blankDocument } from '../document/presets';
import { readContentRows, writeContent, writeContentBatch, type ContentWrite } from './content-database';

// #6853: actual IndexedDB transactions, with independent durable reads as the oracle.
test('multiple reviewed rows commit together and an old revision blocks every row', async () => {
  const first = { ...blankDocument(), id: 'first' }, second = { ...blankDocument(), id: 'second' };
  const initial = await writeContentBatch([
    { kind: 'document', id: first.id, payload: first, expected: 0 },
    { kind: 'document', id: second.id, payload: second, expected: 0 },
  ]);
  assert.equal(initial.ok, true);
  const before = await readContentRows('document');
  assert.equal(before.length, 2);
  assert.ok(before.every(row => row.revision === 1));
  assert.ok(before[0].createdAt < before[1].createdAt);
  const refused = await writeContentBatch([
    { kind: 'document', id: first.id, payload: { ...first, name: 'Would change' }, expected: 1 },
    { kind: 'document', id: second.id, payload: { ...second, name: 'Old tab' }, expected: 0 },
  ]);
  assert.deepEqual(refused, { ok: false, reason: 'conflict' });
  assert.deepEqual(await readContentRows('document'), before, 'no participant advances on conflict');
});

test('immutable evidence policy blocks companion writes while names remain editable', async () => {
  const evidence = { id: 'report', name: 'Native report', snapshot: { verdict: 'fail' } };
  assert.equal((await writeContent('validation', 'report', evidence, 0)).ok, true);
  const doc = { ...blankDocument(), id: 'companion' };
  assert.deepEqual(await writeContentBatch([
    { kind: 'document', id: doc.id, payload: doc, expected: 0 },
    { kind: 'validation', id: 'report', payload: { ...evidence, snapshot: { verdict: 'pass' } }, expected: 1 },
  ]), { ok: false, reason: 'invalid' });
  assert.equal((await readContentRows('document')).length, 0);
  assert.equal((await readContentRows('validation'))[0].revision, 1);
  assert.equal((await writeContentBatch([
    { kind: 'document', id: doc.id, payload: doc, expected: 0 },
    { kind: 'validation', id: 'report', payload: { ...evidence, name: 'Reviewed name' }, expected: 1 },
  ])).ok, true);
  assert.equal((await readContentRows('validation'))[0].revision, 2);
});

test('failure after the first put rolls back every participant', async () => {
  const original = IDBObjectStore.prototype.put;
  let count = 0;
  const refused = mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === 'items' && ++count === 2) throw new DOMException('Full after first row', 'QuotaExceededError');
    return key === undefined ? original.call(this, value) : original.call(this, value, key);
  });
  try {
    const result = await writeContentBatch([
      { kind: 'document', id: 'a', payload: { ...blankDocument(), id: 'a' }, expected: 0 },
      { kind: 'document', id: 'b', payload: { ...blankDocument(), id: 'b' }, expected: 0 },
    ]);
    assert.deepEqual(result, { ok: false, reason: 'quota' });
    assert.equal(count, 2, 'the real transaction reached both puts');
    assert.deepEqual(await readContentRows('document'), [], 'the first scheduled put must not escape the aborted transaction');
  } finally { refused.mock.restore(); }
});

test('tombstones cannot be resurrected and duplicate/boundary requests never advance rows', async () => {
  const doc = { ...blankDocument(), id: 'deleted' };
  await writeContent('document', doc.id, doc, 0);
  await writeContent('document', doc.id, null, 1);
  const before = await readContentRows('document');
  assert.equal(before[0].deleted, true);
  assert.deepEqual(await writeContentBatch([
    { kind: 'document', id: doc.id, payload: doc, expected: 2 },
    { kind: 'document', id: 'new', payload: { ...doc, id: 'new' }, expected: 0 },
  ]), { ok: false, reason: 'conflict' });
  const request: ContentWrite = { kind: 'document', id: 'new', payload: { ...doc, id: 'new' }, expected: 0 };
  for (const invalid of [[], [request, request], Array.from({ length: 101 }, (_, i) => ({ ...request, id: String(i) })),
    [{ ...request, expected: -1 }], [{ ...request, expected: Number.MAX_SAFE_INTEGER }]]) {
    assert.deepEqual(await writeContentBatch(invalid), { ok: false, reason: 'invalid' });
  }
  assert.deepEqual(await readContentRows('document'), before);
});

test('payloads are frozen at invocation before asynchronous transaction opening', async () => {
  const doc = { ...blankDocument(), id: 'frozen', name: 'Reviewed at invocation' };
  const pending = writeContentBatch([{ kind: 'document', id: doc.id, payload: doc, expected: 0 }]);
  doc.name = 'Changed after approval';
  assert.equal((await pending).ok, true);
  const saved = (await readContentRows('document'))[0].payload as { name: string };
  assert.equal(saved.name, 'Reviewed at invocation');
});
