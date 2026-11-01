/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScanLoader } from '../scan-attempt.mjs';

// Real asynchronous Blob reads/JSON failures exercise the controller, not E57
// decoding. Deferred gates control completion order without timers or mock returns.
const good = id => new Blob([JSON.stringify({ id })]);
function setup(gates = new Map()) {
  const state = {}, committed = [], closed = [], errors = [];
  const scans = createScanLoader({
    state,
    read: async file => {
      try {
        await gates.get(file)?.promise;
        return { summary: JSON.parse(await file.text()) };
      } finally { closed.push(file); }
    },
    commit: result => committed.push(result.summary.id),
    onError: error => errors.push(error),
  });
  return { state, committed, closed, errors, ...scans };
}

test('success -> failure -> success publishes only the current scan attempt (#8580)', async () => {
  const loader = setup();
  await loader.loadScan(good('first'));
  assert.deepEqual(loader.committed, ['first']);
  const failed = loader.loadScan(new Blob(['malformed']));
  assert.equal(loader.state.scan, null, 'old success clears synchronously for direct callers');
  assert.equal(loader.state.error, null);
  assert.equal(loader.state.scanPending, true);
  await assert.rejects(failed, error => error instanceof SyntaxError && error === loader.errors[0]);
  assert.equal(loader.state.scan, null);
  assert.match(loader.state.error, /JSON/);
  assert.equal(loader.state.scanPending, false);
  const recovered = loader.loadScan(good('third'));
  assert.equal(loader.state.error, null, 'old error clears before retry completes');
  await recovered;
  assert.equal(loader.state.scan.id, 'third');
  assert.deepEqual(loader.committed, ['first', 'third']);
  assert.equal(loader.closed.length, 3);
  const beforeCancel = { ...loader.state };
  await loader.loadScan(undefined);
  assert.deepEqual(loader.state, beforeCancel);
  assert.equal(loader.closed.length, 3, 'canceled picker opens no source');
});

for (const staleFails of [false, true]) test(`superseded scan ${staleFails ? 'failure' : 'success'} cannot overwrite the latest result (#8580)`, async () => {
  const oldFile = staleFails ? new Blob(['malformed']) : good('old');
  const gate = Promise.withResolvers();
  const loader = setup(new Map([[oldFile, gate]]));
  const old = loader.loadScan(oldFile);
  // Attach rejection observation before releasing the old operation.
  const oldResult = staleFails ? assert.rejects(old, SyntaxError) : old;
  await loader.loadScan(good('latest'));
  const latest = { ...loader.state };
  gate.resolve();
  await oldResult;
  assert.deepEqual(loader.state, latest);
  assert.deepEqual(loader.committed, ['latest']);
  assert.deepEqual(loader.errors, [], 'stale failures do not publish an error');
  assert.equal(loader.closed.length, 2, 'both reads finish their cleanup');
});

test('disposal invalidates a pending scan before any backend commit (#8580)', async () => {
  const file = good('late'), gate = Promise.withResolvers();
  const loader = setup(new Map([[file, gate]]));
  const pending = loader.loadScan(file);
  loader.dispose();
  gate.resolve();
  await pending;
  assert.deepEqual(loader.committed, []);
  assert.equal(loader.state.scan, null);
  assert.equal(loader.state.scanPending, false);
  assert.deepEqual(loader.closed, [file]);
  await assert.rejects(loader.loadScan(good('after-dispose')), /disposed/);
  await loader.loadScan(undefined); // Canceling after disposal is still a no-op.
  assert.deepEqual(loader.closed, [file]);
});
