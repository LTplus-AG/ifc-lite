/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #10264 / #10353: the probe must attribute reads and worker posts to the picked
// source by object identity, never by size (review on #10415).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// Guarded load, not a static import: the revert oracle removes this PR's production files, and a
// static import of a removed module fails the whole file at LOAD, which the oracle cannot tell
// from a broken test. With the guard, every test fails by an ordinary assertion instead.
const TRACKER = new URL('./oom-load-probe-tracker.mjs', import.meta.url);
const trackerModule = existsSync(TRACKER) ? await import(TRACKER.href) : null;
function tracker() { assert.ok(trackerModule, 'scripts/perf/oom-load-probe-tracker.mjs does not exist'); return trackerModule; }
const installSourceTracker = (...a) => tracker().installSourceTracker(...a);
const trackerSummary = (...a) => tracker().trackerSummary(...a);
const LIB = new URL('./oom-load-probe-lib.mjs', import.meta.url);
const libModule = existsSync(LIB) ? await import(LIB.href) : null;
function serverApi() {
  assert.ok(libModule, 'scripts/perf/oom-load-probe-lib.mjs does not exist');
  assert.ok(libModule.serverAttemptSummary !== undefined, 'oom-load-probe-lib.mjs lacks the export serverAttemptSummary');
  return libModule;
}

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
  assert.deepEqual(r.logs.sourceReads.events.map((x) => [x.bytes, x.whole]), [[64, true], [4, false], [32, false]]);
  assert.deepEqual(r.logs.unattributedReads.events.map((x) => x.bytes), [64], 'the lookalike is reported, but not as the source');
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
  const posts = h.tracker.report().logs.workerPosts.events;
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

test('#10353 500 small slice reads then a whole-file read: totals and the large read survive the log cap', async (t) => {
  const h = harness(t);
  const source = new Blob([bytes(64)]);
  h.tracker.markSource(source);
  for (let i = 0; i < 500; i++) { h.tick(1); await source.slice(0, 4).arrayBuffer(); }
  h.tick(1); await source.arrayBuffer();
  const s = trackerSummary(h.tracker.report(), 1000);
  assert.equal(s.sourceReads, 501);
  assert.equal(s.sourceReadBytes, 500 * 4 + 64);
  assert.equal(s.largeSourceReads, 1);
  assert.equal(s.truncated, true);
  assert.equal(s.dropped, 501 - 200);
  assert.equal(s.facts.firstLargeSourceRead.ms, 501);
  assert.equal(s.facts.largestSourceRead.bytes, 64);
  assert.equal(s.facts.firstSourceRead.ms, 1);
  assert.equal(s.events.filter((e) => e.event === 'source-read').length, 200, 'first 100 and last 100 kept');
  assert.equal(s.events.filter((e) => e.event === 'source-read').at(-1).whole, true, 'the last event is kept');
});

test('#10353 worker-post overflow keeps the first source post and exact counts', (t) => {
  const h = harness(t);
  const source = new Blob([bytes(64)]);
  h.tracker.markSource(source);
  const other = new h.Worker('/other.js'), identity = new h.Worker('/identity.js');
  for (let i = 0; i < 300; i++) { h.tick(1); other.postMessage({ blob: new Blob([bytes(16)]) }); }
  h.tick(1); identity.postMessage({ file: source });
  const s = trackerSummary(h.tracker.report(), 1000);
  assert.equal(s.otherPosts, 300);
  assert.equal(s.sourcePosts, 1);
  assert.equal(s.truncated, true);
  assert.deepEqual(s.facts.firstSourcePost, { ms: 301, bytes: 64, worker: '/identity.js' });
  assert.deepEqual(s.facts.firstOtherPost, { ms: 1, bytes: 16, worker: '/other.js' });
});

test('#10353 a source nested anywhere in a worker or port message, or in its transfer list, is recorded (review on #10415)', (t) => {
  const saved = Object.fromEntries(['arrayBuffer', 'text', 'bytes', 'stream', 'slice'].map((m) => [m, Blob.prototype[m]]));
  t.after(() => { for (const [m, f] of Object.entries(saved)) Blob.prototype[m] = f; });
  class FakeWorker { postMessage() {} }
  class FakePort { postMessage() {} }
  let clock = 0;
  const target = {};
  const tracker = installSourceTracker({ Blob, Worker: FakeWorker, MessagePort: FakePort, target, now: () => ++clock, minBytes: 8 });
  const source = new Blob([new Uint8Array(64)]);
  tracker.markSource(source);
  const w = new target.Worker('/deep.js');
  w.postMessage({ payload: { file: source } });
  w.postMessage({ a: [{ b: new Map([['k', new Set([source.slice(0, 16)])]]) }] });
  new FakePort().postMessage({ deep: { deeper: { file: source } } });
  const cyclic = { self: null }; cyclic.self = cyclic;
  w.postMessage(cyclic);
  const buf = new ArrayBuffer(8);
  w.postMessage({ x: { y: { z: { file: source } } } }, [buf]); // three levels deep
  w.postMessage({ note: 'transfer' }, { transfer: [source] }); // in the transfer list (Blobs are not transferable; the scan still looks)
  const s = trackerSummary(tracker.report(), 0);
  assert.equal(s.sourcePosts, 5);
  const posts = s.events.filter((e) => e.event === 'worker-post');
  assert.deepEqual(posts.map((e) => e.worker), ['/deep.js', '/deep.js', 'MessagePort', '/deep.js', '/deep.js']);
  assert.deepEqual(posts.map((e) => e.path), ['message.payload.file', 'message.a[0].b.get(0).<set 0>', 'message.deep.deeper.file', 'message.x.y.z.file', 'transfer[0]']);
  assert.ok(posts.every((e) => e.scanTruncated === false));
  assert.equal(s.incompleteScans, 0);
  assert.deepEqual(s.events.filter((e) => e.event === 'worker-created').map((e) => [e.url, e.blobUrl]), [['/deep.js', false]]);
});

test('#10353 BroadcastChannel posts, blob: URLs of the source and blob-URL workers are recorded; unwatched channels are listed', (t) => {
  const saved = Object.fromEntries(['arrayBuffer', 'text', 'bytes', 'stream', 'slice'].map((m) => [m, Blob.prototype[m]]));
  t.after(() => { for (const [m, f] of Object.entries(saved)) Blob.prototype[m] = f; });
  class FakeWorker { postMessage() {} }
  class FakeChannel { constructor(name) { this.name = name; } postMessage() {} }
  const fakeUrl = { createObjectURL: () => 'blob:http://x/1' };
  const target = {};
  const tracker = installSourceTracker({ Blob, Worker: FakeWorker, BroadcastChannel: FakeChannel, URL: fakeUrl, target, now: () => 7 });
  const source = new Blob([new Uint8Array(4)]);
  tracker.markSource(source);
  new FakeChannel('ifc').postMessage({ file: source });
  const url = fakeUrl.createObjectURL(source);
  new target.Worker(url);
  const s = trackerSummary(tracker.report(), 0);
  assert.equal(s.sourcePosts, 1);
  assert.equal(s.events.find((e) => e.event === 'worker-post').worker, 'BroadcastChannel ifc');
  assert.equal(s.sourceObjectUrls, 1);
  assert.deepEqual(s.facts.firstSourceObjectUrl, { ms: 0, url: 'blob:http://x/1' }, 'times are relative to the page pick (same tick)');
  assert.equal(s.events.find((e) => e.event === 'worker-created').blobUrl, true);
  assert.ok(s.channels.instrumented.includes('BroadcastChannel.postMessage'));
  assert.ok(s.channels.notInstrumented.some((c) => /MessagePort/.test(c)), 'no MessagePort given: listed as not watched');
  assert.ok(s.channels.notInstrumented.some((c) => /ReadableStream/.test(c)));
});

test('#10353 a message beyond the scan budget is an incomplete scan, not "no source"', async (t) => {
  const saved = Object.fromEntries(['arrayBuffer', 'text', 'bytes', 'stream', 'slice'].map((m) => [m, Blob.prototype[m]]));
  t.after(() => { for (const [m, f] of Object.entries(saved)) Blob.prototype[m] = f; });
  class FakeWorker { postMessage() {} }
  const target = {};
  const tracker = installSourceTracker({ Blob, Worker: FakeWorker, target, now: () => 5, scanBudget: 10 });
  tracker.markSource(new Blob([new Uint8Array(4)]));
  new target.Worker('/big.js').postMessage({ list: Array.from({ length: 50 }, (_, i) => ({ i })) });
  const s = trackerSummary(tracker.report(), 0);
  assert.equal(s.incompleteScans, 1);
  let reads = 0;
  const wide = new Array(1000000);
  for (let i = 0; i < 40; i++) Object.defineProperty(wide, i, { get() { reads++; return {}; } });
  new target.Worker('/wide.js').postMessage(wide);
  assert.ok(reads <= 11, `child expansion must stop at the budget, read ${reads} children`);
  assert.deepEqual(s.facts.firstIncompleteScan, { ms: 0, worker: '/big.js' });
  assert.equal(s.events.filter((e) => e.event === 'worker-post').length, 0, 'nothing found in the part scanned');
  const { serverAttemptSummary } = serverApi();
  const v = serverAttemptSummary([{ ms: 1, event: 'request' }, { ms: 50, event: 'dialog', text: 'This model may exceed available memory' }], { watching: true, tracker: s });
  assert.equal(v.sourcePostBeforeDecision, null);
  assert.match(v.unknownBecause.sourcePostBeforeDecision, /too large to scan/);
});

test('#10353 the pick is stamped by the page when the source is marked; watched requests use the same clock (review on #10415)', async (t) => {
  const saved = Object.fromEntries(['arrayBuffer', 'text', 'bytes', 'stream', 'slice'].map((m) => [m, Blob.prototype[m]]));
  t.after(() => { for (const [m, f] of Object.entries(saved)) Blob.prototype[m] = f; });
  let clock = 1000;
  const target = { location: { href: 'http://127.0.0.1:5173/' }, fetch: (url) => (String(url).includes('49159') ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({ status: 200 })) };
  const tracker = installSourceTracker({ Blob, target, now: () => clock, watchOrigin: 'http://127.0.0.1:49159' });
  // The driver has called openAndWaitInteractive (its clock: 990), but the input has not delivered the file yet.
  clock = 1005; target.fetch('http://127.0.0.1:49159/api/v1/health').catch(() => {}); // still before the real pick
  clock = 1010; tracker.markSource(new Blob([new Uint8Array(4)])); // the real pick
  clock = 1030; await target.fetch('http://127.0.0.1:49159/api/v1/health').catch(() => {});
  clock = 1031; await target.fetch('http://127.0.0.1:5173/other').catch(() => {}); // not the watched origin
  await new Promise((r) => setTimeout(r, 0));
  const s = trackerSummary(tracker.report(), 990);
  assert.equal(s.pickKnown, true);
  assert.equal(s.pickAt, 1010);
  assert.equal(s.requestsBeforePick, 1);
  assert.equal(s.requestsAfterPick, 1);
  assert.deepEqual(s.facts.startupRequests.map((e) => e.ms), [-5], 'between the driver call and the real pick: startup, not the attempt');
  assert.equal(s.facts.firstRequestAfterPick.ms, 20);
  assert.ok(s.events.filter((e) => e.event === 'request').every((e) => e.clock === 'page'));
  assert.ok(s.events.some((e) => e.event === 'requestfailed' && /Failed to fetch/.test(e.error)));
});

test('#10353 without a page pick stamp, times fall back to the driver call and pickKnown is false', (t) => {
  const saved = Object.fromEntries(['arrayBuffer', 'text', 'bytes', 'stream', 'slice'].map((m) => [m, Blob.prototype[m]]));
  t.after(() => { for (const [m, f] of Object.entries(saved)) Blob.prototype[m] = f; });
  const tracker = installSourceTracker({ Blob, target: {}, now: () => 50 });
  const s = trackerSummary(tracker.report(), 40);
  assert.equal(s.pickKnown, false);
  assert.equal(s.sourceMarked, false);
});
