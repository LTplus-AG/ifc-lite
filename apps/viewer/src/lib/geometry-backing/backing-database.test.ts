/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10876: a commit's `write` callback error is not a closed connection, so it is
 * never retried (the batch would run twice), and a read whose collector throws
 * rejects instead of leaving its caller waiting forever.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { BackingDatabase, CHUNKS } from './backing-database';

let names = 0;
const open = () => BackingDatabase.open({ name: `backing-db-${process.pid}-${names++}`, locks: null });

it('#10876 a write callback that throws InvalidStateError (a pending request read) runs once and commits nothing', async () => {
  const db = await open();
  try {
    let writes = 0;
    await assert.rejects(db.commit([CHUNKS], (tx) => {
      writes++;
      const request = tx.objectStore(CHUNKS).put(new Uint8Array(4), [db.session, 'b', 0]);
      void request.result; // still pending: the getter throws InvalidStateError
    }), (error: Error) => error.name === 'InvalidStateError');
    assert.equal(writes, 1, 'the callback error is not a closed connection: never retried on a reopened one');
    assert.equal(await db.count(CHUNKS, 'b'), 0, 'and the aborted batch left nothing behind');
  } finally { db.close(); }
});

it('#10876 a read whose collector throws rejects with that error instead of never settling', async () => {
  const db = await open();
  try {
    const failure = new Error('collector failed');
    const read = db.read([CHUNKS], () => () => { throw failure; });
    const settled = await Promise.race([read.then(() => 'resolved', (error) => error), new Promise((done) => setTimeout(() => done('pending'), 500))]);
    assert.equal(settled, failure, 'rejected with the collector error');
  } finally { db.close(); }
});
