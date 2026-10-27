/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetainedClient, type RetainedWorker } from './retained-client';
import { RetainedHostError } from './retained-protocol';
import type { RetainedHostEvent, RetainedHostRequest, RetainedHostResponse } from './retained-protocol';

// Protocol fixture only: no engine/geometry implementation is mocked.
class FakeWorker implements RetainedWorker {
  onmessage: RetainedWorker['onmessage'] = null;
  onerror: RetainedWorker['onerror'] = null;
  onmessageerror: RetainedWorker['onmessageerror'] = null;
  requests: RetainedHostRequest[] = [];
  terminated = 0;
  postMessage(request: RetainedHostRequest) { this.requests.push(request); }
  terminate() { this.terminated++; }
  emit(event: RetainedHostEvent | { kind: 'error'; code: 'engine_missing'; message: string }, runId = this.requests.at(-1)!.runId) {
    this.onmessage?.({ data: { ...event, runId } } as MessageEvent<RetainedHostResponse>);
  }
}
const start: RetainedHostEvent = {
  kind: 'start', candidateIds: new Uint32Array([10, 20, 30, 40]),
  frame: { x: 2600000, y: 0, z: 0, needsShift: true },
};
async function collect(events: AsyncIterable<RetainedHostEvent>) {
  const result: RetainedHostEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

test('#7955 M2-B Cancel terminates the Worker and non-received candidates become cancelled', async (t) => {
  const worker = new FakeWorker();
  const client = new RetainedClient(() => worker);
  t.after(() => client.unload());
  const bytes = new Uint8Array([1, 2, 3]);
  const events = client.run(bytes);
  const first = events.next();
  worker.emit(start);
  assert.equal((await first).value?.kind, 'start');
  worker.emit({ kind: 'published', expressId: 10, ifcType: 'IfcWall', marker: 'PresentationObligationsUnmet', obligationsUnmet: ['IfcAppearance'], meshes: [] });
  worker.emit({ kind: 'refused', status: 'refused', expressId: 20, ifcType: 'IfcWall', code: 'opening_strategy' });
  client.cancel();
  assert.equal(worker.terminated, 1, 'Cancel must terminate the host, including its in-flight product');
  const rest = await collect(events);
  assert.deepEqual(rest.filter(e => e.kind === 'cancelled').map(e => e.expressId), [30, 40]);
  assert.equal(rest.filter(e => e.kind === 'published').length, 1, 'already published output stays');
  assert.deepEqual(rest.at(-1), { kind: 'complete', cancelled: true });
  assert.equal(bytes.byteLength, 3, 'source is not detached');
});

test('#7955 lazy spawn, warm reuse, stale-message isolation, and idle terminate', async (t) => {
  const workers: FakeWorker[] = [];
  const client = new RetainedClient(() => { const w = new FakeWorker(); workers.push(w); return w; }, 20);
  t.after(() => client.unload());
  assert.equal(workers.length, 0);
  for (let n = 0; n < 2; n++) {
    const events = client.run(new Uint8Array([1]));
    const next = events.next();
    assert.equal(workers.length, 1);
    if (n) workers[0].emit({ kind: 'complete', cancelled: false }, 1);
    workers[0].emit(start);
    assert.equal((await next).value?.kind, 'start');
    workers[0].emit({ kind: 'complete', cancelled: false });
    assert.equal((await collect(events)).length, 1);
  }
  assert.equal(workers[0].terminated, 0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(workers[0].terminated, 1);
  const nextRun = client.run(new Uint8Array());
  const pending = nextRun.next();
  assert.equal(workers.length, 2);
  client.cancel();
  await pending;
  await collect(nextRun);
});

test('#7955 crash and message decode failures reject with typed host errors', async (t) => {
  for (const kind of ['error', 'messageerror'] as const) {
    const worker = new FakeWorker();
    const client = new RetainedClient(() => worker);
    t.after(() => client.unload());
    const pending = client.run(new Uint8Array()).next();
    if (kind === 'error') worker.onerror?.({ message: 'crashed', preventDefault() {} } as ErrorEvent);
    else worker.onmessageerror?.({} as MessageEvent);
    await assert.rejects(pending, (error: unknown) => error instanceof RetainedHostError && error.code === 'worker_crash');
    assert.equal(worker.terminated, 1);
  }
});

test('#7955 startup and missing-engine failures never fall back to exact', async (t) => {
  const broken = new RetainedClient(() => { throw new Error('cannot construct Worker'); });
  await assert.rejects(broken.run(new Uint8Array()).next(), (error: unknown) =>
    error instanceof RetainedHostError && error.code === 'startup' && error.message.includes('Reload with exact kernel'));
  const worker = new FakeWorker();
  const client = new RetainedClient(() => worker);
  t.after(() => client.unload());
  const pending = client.run(new Uint8Array()).next();
  worker.emit({ kind: 'error', code: 'engine_missing', message: 'engine unavailable' });
  await assert.rejects(pending, (error: unknown) => error instanceof RetainedHostError && error.code === 'engine_missing');
  assert.equal(worker.requests.length, 1, 'no automatic retry');
  assert.equal(worker.terminated, 1);
});

test('#7955 abort, unload, pagehide and iterator abandonment release the host', async (t) => {
  for (const action of ['abort', 'unload', 'pagehide', 'return'] as const) {
    const worker = new FakeWorker();
    const lifecycle = new EventTarget();
    const client = new RetainedClient(() => worker, 300000, lifecycle);
    t.after(() => client.unload());
    const abort = new AbortController();
    const events = client.run(new Uint8Array(), { signal: abort.signal });
    const pending = events.next();
    worker.emit(start);
    await pending;
    if (action === 'abort') abort.abort();
    if (action === 'unload') client.unload();
    if (action === 'pagehide') lifecycle.dispatchEvent(new Event('pagehide'));
    if (action === 'return') await events.return(undefined);
    else await collect(events);
    assert.equal(worker.terminated, 1, action);
  }
});

test('#7955 already-aborted loads do not spawn; overlapping loads reject', async (t) => {
  const worker = new FakeWorker();
  const client = new RetainedClient(() => worker);
  t.after(() => client.unload());
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await collect(client.run(new Uint8Array(), { signal: abort.signal })), []);
  assert.equal(worker.requests.length, 0);
  const events = client.run(new Uint8Array());
  const next = events.next();
  await assert.rejects(client.run(new Uint8Array()).next(), (error: unknown) => error instanceof RetainedHostError && error.code === 'busy');
  client.cancel();
  await next;
  await collect(events);
});
