/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #10264 / #10353: the probe must attribute reads and worker posts to the picked
// source by object identity, never by size (review on #10415).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installSourceTracker, trackerSummary } from './oom-load-probe-tracker.mjs';

/**
 * The page patches Blob.prototype itself (slices are plain Blobs), so the test does too,
 * and restores the originals afterwards so no patch leaks into another test.
 */
const BLOB_METHODS = ['arrayBuffer', 'text', 'bytes', 'stream', 'slice'];
function harness(t) {
  const saved = Object.fromEntries(BLOB_METHODS.map((m) => [m, Blob.prototype[m]]));
  t.after(() => { for (const m of BLOB_METHODS) Blob.prototype[m] = saved[m]; });
  class FakeReader { readAsArrayBuffer() {} readAsText() {} }
  class FakeWorker { constructor(url) { this.url = url; this.sent = []; } postMessage(m) { this.sent.push(m); } }
  let clock = 1000;
  const target = {};
  const tracker = installSourceTracker({ Blob, FileReader: FakeReader, Worker: FakeWorker, target, now: () => clock, minBytes: 8 });
  return { TBlob: Blob, FakeReader, Worker: target.Worker, tracker, tick: (ms) => { clock += ms; } };
}
const bytes = (n) => new Uint8Array(n);

test('#10353 a read of the picked File or a slice of it is a source read; an equal-sized other Blob is not', async (t) => {
  const h = harness(t);
  const source = new h.TBlob([bytes(64)]);
  const lookalike = new h.TBlob([bytes(64)]); // same size, e.g. a cache entry
  h.tracker.markSource(source);
  h.tick(5); await source.arrayBuffer();
  h.tick(5); await lookalike.arrayBuffer();
  const head = source.slice(0, 4);
  h.tick(5); await head.arrayBuffer();
  new h.FakeReader().readAsArrayBuffer(source.slice(8, 40));
  const r = h.tracker.report();
  assert.deepEqual(r.sourceReads.map((x) => [x.bytes, x.whole]), [[64, true], [4, false], [32, false]]);
  assert.deepEqual(r.unattributedReads.map((x) => x.bytes), [64], 'the lookalike is reported, but not as the source');
  const s = trackerSummary(r, 1000);
  assert.equal(s.sourceReads, 3);
  assert.equal(s.largeSourceReads, 1, 'only the whole-file read is large (4 B and 32 B slices are under 1 MiB)');
  assert.equal(s.unattributedReads, 1);
  assert.equal(s.unattributedBytes, 64);
});

test('#10353 small unrelated reads are ignored; an unmarked page reports zero source reads, not unknown', async (t) => {
  const h = harness(t);
  await new h.TBlob([bytes(4)]).arrayBuffer(); // under minBytes, not the source
  const s = trackerSummary(h.tracker.report(), 1000);
  assert.equal(s.reported, true);
  assert.equal(s.sourceMarked, false);
  assert.equal(s.sourceReads, 0);
  assert.equal(s.unattributedReads, 0);
});

test('#10353 worker posts record time, worker URL and whether the Blob is the source', (t) => {
  const h = harness(t);
  const source = new h.TBlob([bytes(64)]);
  h.tracker.markSource(source);
  const w = new h.Worker('/assets/source-identity.worker.js', { name: 'identity' });
  h.tick(10); w.postMessage({ file: source });
  h.tick(10); w.postMessage({ blob: new h.TBlob([bytes(64)]) });
  h.tick(10); w.postMessage({ part: source.slice(0, 16) });
  h.tick(10); w.postMessage('ping');
  const posts = h.tracker.report().workerPosts;
  assert.deepEqual(posts.map((p) => [p.t, p.source, p.bytes]), [[1010, true, 64], [1020, false, 64], [1030, true, 16]]);
  assert.equal(posts[0].worker, '/assets/source-identity.worker.js (identity)');
  assert.equal(w.sent.length, 4, 'messages still reach the worker');
  const s = trackerSummary(h.tracker.report(), 1000);
  assert.equal(s.sourcePosts, 2);
  assert.equal(s.otherPosts, 1);
  assert.deepEqual(s.events.filter((e) => e.event === 'worker-post').map((e) => [e.ms, e.source]), [[10, true], [20, false], [30, true]]);
});

test('#10353 no tracker report means every count is unknown', () => {
  const s = trackerSummary(null, 0);
  assert.equal(s.reported, false);
  for (const k of ['sourceReads', 'largeSourceReads', 'unattributedReads', 'sourcePosts', 'otherPosts']) assert.equal(s[k], null, k);
  assert.deepEqual(s.events, []);
});
