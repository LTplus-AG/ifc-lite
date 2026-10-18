// SPDX-License-Identifier: MPL-2.0
// Client lifecycle only; protocol fixture supplies no SDK geometry evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SmlibWorkerTransport } from './client.mjs';
import { request } from './contract.mjs';
class FixtureWorker {
  static instances = [];
  constructor() { FixtureWorker.instances.push(this); }
  terminate() { this.terminated = true; }
  postMessage(message, transfers) { this.message = structuredClone(message, { transfer: transfers }); }
  reply() { this.onmessage({ data: { id: this.message.id, frames: [request(0)] } }); }
}
test('browser review: poison invalidates live token and stale retirement preserves restart', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = FixtureWorker;
  const transport = new SmlibWorkerTransport();
  try {
    const old = transport.incarnation;
    const pending = transport.batch([request(0)], old);
    FixtureWorker.instances.at(-1).onmessage({ data: { fatal: 'fault fixture' } });
    await assert.rejects(pending, /fault fixture/);
    assert.equal(transport.incarnation, undefined);
    const fresh = transport.restart();
    transport.retire(old);
    assert.equal(transport.incarnation, fresh);
    const healthy = transport.batch([request(0)], fresh);
    FixtureWorker.instances.at(-1).reply();
    await healthy;
    transport.retire(fresh);
    assert.equal(transport.incarnation, undefined);
  } finally {
    transport.dispose();
    globalThis.Worker = previous;
  }
});
test('browser review: pending admission labels unsent commit without detachment', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = FixtureWorker;
  const transport = new SmlibWorkerTransport({ maxPending: 1 });
  try {
    const token = transport.incarnation;
    const pending = transport.batch([request(0)], token);
    const commit = request(15);
    await assert.rejects(transport.batch([commit], token), (error) => error.submitted === false);
    assert.equal(commit.byteLength, 12);
    FixtureWorker.instances.at(-1).reply();
    await pending;
  } finally {
    transport.dispose();
    globalThis.Worker = previous;
  }
});
