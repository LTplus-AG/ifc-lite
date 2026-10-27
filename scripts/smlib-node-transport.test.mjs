// SPDX-License-Identifier: MPL-2.0
// #7955: lifetime/ownership/protocol invariants only, with no SDK geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SmlibWorkerTransport as NodeTransport } from '../native/smlib-adapter/node/client.mjs';
import { SmlibWorkerTransport as BrowserTransport } from '../native/smlib-adapter/browser/client.mjs';
import { request } from '../native/smlib-adapter/browser/contract.mjs';

const browser = new URL('../native/smlib-adapter/browser/', import.meta.url);
const peer = new URL('tests/protocol-worker.mjs', browser);
const host = new URL('../native/smlib-adapter/node/worker.mjs', import.meta.url);

// Browser API facade over real worker_threads, so both clients exchange the
// same messages with the same peer. Production never sets a global Worker.
class BrowserWorker {
  constructor(url, options) {
    assert.deepEqual(options, { type: 'module' });
    this.worker = new Worker(host, { workerData: { workerUrl: url.href, heap: new SharedArrayBuffer(8) } });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
    this.worker.on('messageerror', () => this.onmessageerror?.());
  }
  postMessage(message, transfers) { this.worker.postMessage(message, transfers); }
  terminate() { return this.worker.terminate(); }
}

for (const [name, Transport] of [['node', NodeTransport], ['browser', BrowserTransport]]) {
  test(`${name}: browser protocol parity, admission and lifecycle (#7955)`, async t => {
    const previous = globalThis.Worker;
    globalThis.Worker = BrowserWorker;
    t.after(() => { globalThis.Worker = previous; });
    const transport = new Transport({ workerUrl: peer, maxPending: 1, timeout: 3000 });
    t.after(() => transport.dispose());
    const first = transport.incarnation;
    const bytes = request(97), expected = bytes.slice(0);
    const pending = transport.batch([bytes], first);
    assert.equal(bytes.byteLength, 0, 'ownership transfers synchronously');
    const unsent = request(0);
    await assert.rejects(transport.batch([unsent], first), error => error.submitted === false);
    assert.equal(unsent.byteLength, 12);
    assert.deepEqual(await pending, [expected], 'opaque frame bytes survive both transfer directions');
    for (const frames of [[], Array.from({ length: 257 }, () => request(0)), [new ArrayBuffer(11)], [new ArrayBuffer(4097)], [new Uint8Array(12)]]) {
      await assert.rejects(transport.batch(frames, first), /invalid frame batch/);
    }
    const duplicate = request(0);
    await assert.rejects(transport.batch([duplicate, duplicate], first), /invalid frame batch/);
    const limit = Array.from({ length: 256 }, (_, i) => i % 2 ? new ArrayBuffer(4096) : request(0));
    const lengths = limit.map(bytes => bytes.byteLength);
    assert.deepEqual((await transport.batch(limit, first)).map(bytes => bytes.byteLength), lengths);
    const interrupted = transport.batch([request(97)], first);
    const rejected = assert.rejects(interrupted, /restarted/);
    const fresh = transport.restart();
    await rejected;
    assert.notEqual(fresh, first);
    transport.retire(first);
    transport.retire(undefined);
    assert.equal(transport.incarnation, fresh);
    await assert.rejects(transport.batch([unsent], first), /stale worker incarnation/);
    await transport.batch([unsent], fresh);
    const foreign = new Transport({ workerUrl: peer });
    try { await assert.rejects(transport.batch([request(0)], foreign.incarnation), /stale/); }
    finally { foreign.dispose(); }
    transport.retire(fresh);
    assert.equal(transport.incarnation, undefined);
    await assert.rejects(transport.batch([request(0)], fresh), /unavailable/);
    transport.restart();
    transport.dispose();
    assert.throws(() => transport.restart(), /disposed/);
  });

  test(`${name}: fatal and malformed replies poison all pending batches (#7955)`, async t => {
    const previous = globalThis.Worker;
    globalThis.Worker = BrowserWorker;
    t.after(() => { globalThis.Worker = previous; });
    for (const op of [90, 92, 93, 94, 95, 96]) {
      const transport = new Transport({ workerUrl: peer, timeout: 3000 });
      try {
        const token = transport.incarnation;
        const outcomes = await Promise.allSettled([
          transport.batch([request(op)], token), transport.batch([request(97)], token),
        ]);
        for (const outcome of outcomes) {
          assert.equal(outcome.status, 'rejected', `${op}: every pending batch rejected`);
          assert.match(outcome.reason.message, /inert worker fault|invalid worker response/);
        }
        assert.equal(transport.incarnation, undefined);
      } finally { transport.dispose(); }
    }
  });
}

test('Node: hung browser fixture is terminated at the poison deadline (#7955)', { timeout: 5000 }, async () => {
  const transport = new NodeTransport({ workerUrl: new URL('tests/hung-worker.mjs', browser), timeout: 150 });
  try {
    const token = transport.incarnation;
    const outcomes = await Promise.allSettled([transport.batch([request(0)], token), transport.batch([request(0)], token)]);
    assert.ok(outcomes.every(result => result.status === 'rejected' && /deadline/.test(result.reason.message)));
    assert.equal(transport.incarnation, undefined);
    transport.workerUrl = peer;
    const next = transport.restart();
    assert.notEqual(next, token);
    await transport.batch([request(0)], next);
  } finally { transport.dispose(); }
});

test('Node: clean exit rejects pending work promptly (#7955)', async () => {
  const transport = new NodeTransport({ workerUrl: peer, timeout: 3000 });
  try {
    await assert.rejects(transport.batch([request(91)], transport.incarnation), /worker exited/);
    assert.equal(transport.incarnation, undefined);
  } finally { transport.dispose(); }
});

test('Node: canonical browser Worker and missing-asset fixture without a wasm build (#7955)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'smlib-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tests'));
  for (const name of ['worker.mjs', 'module.mjs', 'tests/missing-asset-worker.mjs']) {
    await copyFile(new URL(name, browser), join(root, name));
  }
  await copyFile(new URL('./lib/__fixtures__/smlib-node/module.mjs', import.meta.url), join(root, 'ifclite_smlib_browser.mjs'));
  const transport = new NodeTransport({ workerUrl: pathToFileURL(join(root, 'worker.mjs')), timeout: 3000 });
  t.after(() => transport.dispose());
  // Queue before asynchronous module initialization; the canonical worker
  // serializes batches and dispatchOwned copies independently owned replies.
  const input = request(0), expected = input.slice(0);
  const one = transport.batch([input], transport.incarnation);
  const two = transport.batch([request(1)], transport.incarnation);
  assert.deepEqual(await one, [expected]);
  await two;
  assert.ok(transport.peakHeapBytes > 0);
  const peak = transport.peakHeapBytes;
  transport.workerUrl = pathToFileURL(join(root, 'tests/missing-asset-worker.mjs'));
  const next = transport.restart();
  await assert.rejects(transport.batch([request(0)], next), /WASM initialization failed:.*ENOENT.*intentionally-absent.wasm/);
  assert.equal(transport.incarnation, undefined);
  assert.ok(transport.peakHeapBytes >= peak, 'peak survives worker retirement');
});

test('Node: constructor bounds reject before starting a worker (#7955)', () => {
  for (const timeout of [0, -1, NaN, Infinity]) assert.throws(() => new NodeTransport({ timeout }), /invalid timeout/);
  for (const maxPending of [0, -1, 1.5, Infinity]) assert.throws(() => new NodeTransport({ maxPending }), /pending limit/);
});
