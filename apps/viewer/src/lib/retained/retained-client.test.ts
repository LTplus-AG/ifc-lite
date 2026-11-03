/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetainedClient, type RetainedWorker } from './retained-client';
import { hostFailure, isAllocationFailure, RETAINED_MAX_SOURCE_BYTES, RetainedHostError, watchUncaught } from './retained-protocol';
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
  emit(event: RetainedHostEvent | { kind: 'error'; code: 'engine_missing' | 'out_of_memory'; message: string }, runId = this.requests.at(-1)!.runId) {
    this.onmessage?.({ data: { ...event, runId } } as MessageEvent<RetainedHostResponse>);
  }
}
const start: RetainedHostEvent = {
  kind: 'start', candidateIds: new Uint32Array([10, 20, 30, 40]),
  frame: { rtcOffset: new Float64Array([2600000, 0, 0]), needsShift: true },
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

test('#7955 a source wasm32 cannot hold is refused before a Worker spawns; one over the old 256 MiB cap is sent', async (t) => {
  let spawned = 0;
  const worker = new FakeWorker();
  const client = new RetainedClient(() => { spawned++; return worker; });
  t.after(() => client.unload());
  // The size check reads byteLength only, so no gigabytes are allocated here.
  const sized = (byteLength: number) => Object.defineProperty(new Uint8Array(1), 'byteLength', { value: byteLength });
  await assert.rejects(client.run(sized(RETAINED_MAX_SOURCE_BYTES + 1)).next(), (error: unknown) =>
    error instanceof RetainedHostError && error.code === 'source_too_large' && /2 GiB/.test(error.message));
  assert.equal(spawned, 0);
  const pending = client.run(sized(342_657_851)).next();
  assert.equal(worker.requests.length, 1, 'a 327 MiB source reaches the host');
  worker.emit({ kind: 'error', code: 'out_of_memory', message: 'unreachable' });
  await assert.rejects(pending, (error: unknown) => error instanceof RetainedHostError && error.code === 'out_of_memory');
  assert.equal(worker.terminated, 1, 'the trapped host is released');
});

test('#7955 a source too big to clone into the host is an out_of_memory failure, other hand-off failures are startup', async () => {
  for (const [thrown, code] of [
    [new DOMException("Failed to execute 'postMessage' on 'Worker': Data cannot be cloned, out of memory.", 'DataCloneError'), 'out_of_memory'],
    [new TypeError('worker gone'), 'startup'],
  ] as const) {
    const worker = new FakeWorker();
    worker.postMessage = () => { throw thrown; };
    const client = new RetainedClient(() => worker);
    await assert.rejects(client.run(new Uint8Array(1)).next(), (error: unknown) => error instanceof RetainedHostError && error.code === code);
    assert.equal(worker.terminated, 1);
  }
});

test('#7955 an allocation failure is the abort trap without a recorded panic, or an error that names one', () => {
  for (const text of ['unreachable', 'unreachable executed', 'Unreachable code should not be executed']) {
    assert.equal(isAllocationFailure(new WebAssembly.RuntimeError(text), false), true, `${text}: a failed allocation aborts without the panic hook`);
  }
  assert.equal(isAllocationFailure(new WebAssembly.RuntimeError('unreachable'), true), false, 'a panic recorded its location: a genuine panic');
  for (const text of ['memory access out of bounds', 'null function or function signature mismatch', 'divide by zero', 'table index is out of bounds']) {
    assert.equal(isAllocationFailure(new WebAssembly.RuntimeError(text), false), false, `${text} is a crash, not memory`);
  }
  assert.equal(isAllocationFailure(new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded'), false), true);
  assert.equal(isAllocationFailure(new RangeError('Array buffer allocation failed'), false), true);
  assert.equal(isAllocationFailure(new RangeError('Maximum call stack size exceeded'), false), false);
  assert.equal(isAllocationFailure(new TypeError('session.run is not a function'), false), false);
  assert.equal(isAllocationFailure('engine unavailable', false), false);
});

test('#7955 a host failure is out_of_memory when it is one, otherwise the phase it failed in', () => {
  assert.deepEqual(hostFailure(new WebAssembly.RuntimeError('unreachable'), 'worker_crash', false), { code: 'out_of_memory', message: 'unreachable' });
  assert.deepEqual(hostFailure(new WebAssembly.RuntimeError('unreachable'), 'worker_crash', true), { code: 'worker_crash', message: 'unreachable' });
  assert.deepEqual(hostFailure(new WebAssembly.RuntimeError('memory access out of bounds'), 'worker_crash', false),
    { code: 'worker_crash', message: 'memory access out of bounds' });
  assert.deepEqual(hostFailure(new TypeError('no engine'), 'engine_missing', false), { code: 'engine_missing', message: 'no engine' });
  for (const phase of ['startup', 'engine_missing'] as const) {
    assert.deepEqual(hostFailure(new WebAssembly.RuntimeError('memory access out of bounds'), phase, false),
      { code: 'worker_crash', message: 'memory access out of bounds' }, `a non-allocation trap during ${phase} is a crash, not classified by its text`);
    assert.equal(hostFailure(new WebAssembly.RuntimeError('unreachable'), phase, false).code, 'out_of_memory', `an allocation failure during ${phase} stays memory`);
  }
  assert.deepEqual(hostFailure(new TypeError('session.run is not a function'), 'startup', false),
    { code: 'startup', message: 'session.run is not a function' }, 'a non-trap startup error keeps its phase');
});

test('#7955 a trap that escapes the awaited run reaches the host as its own uncaught error or rejection', () => {
  const target = new EventTarget();
  const seen: unknown[] = [];
  let claim = true;
  watchUncaught(target, (error) => { seen.push(error); return claim; });
  const trap = new WebAssembly.RuntimeError('unreachable');
  const error = Object.assign(new Event('error', { cancelable: true }), { error: trap, message: 'Uncaught RuntimeError: unreachable' });
  target.dispatchEvent(error);
  assert.equal(seen[0], trap, 'the trap object itself, so its kind can be classified');
  assert.equal(error.defaultPrevented, true, 'a claimed failure is not also reported to the client as a crash');
  const rejection = Object.assign(new Event('unhandledrejection', { cancelable: true }), { reason: trap });
  target.dispatchEvent(rejection);
  assert.equal(seen[1], trap);
  claim = false;
  const idle = Object.assign(new Event('error', { cancelable: true }), { error: trap });
  target.dispatchEvent(idle);
  assert.equal(idle.defaultPrevented, false, 'outside a run the error stays the client\'s worker crash');
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
