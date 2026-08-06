/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

/**
 * Contract tests for the overlay-parse worker client (#2183).
 *
 * The whole point of this module is that the worker is TERMINATED once the
 * last job settles: terminating is what returns the decode scratch and the
 * never-shrinking `WebAssembly.Memory` to the OS. A client that keeps the
 * worker alive would re-introduce the bug in a different realm, so the
 * termination assertions below are the load-bearing ones.
 */

interface PostedMessage {
  id: number;
  kind: string;
  source: Uint8Array;
}

const instances: FakeWorker[] = [];

/** Records posts and lets each test drive replies by hand. */
class FakeWorker {
  static failNextConstruct = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly posted: PostedMessage[] = [];
  terminated = 0;

  constructor(public url: unknown, public options: unknown) {
    instances.push(this);
  }

  postMessage(message: PostedMessage, transfer?: unknown[]): void {
    this.posted.push(message);
    // A transfer list here would detach the viewer's own SAB-backed source.
    assert.equal(transfer, undefined, 'source must be shared, never transferred');
  }

  terminate(): void {
    this.terminated++;
  }

  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
}

let parseOverlayLines: typeof import('./index.js').parseOverlayLines;

beforeEach(async () => {
  instances.length = 0;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  // Fresh module state per test: the worker handle and the in-flight count
  // are module-level singletons.
  const mod = await import(`./index.js?t=${Date.now()}${Math.random()}`);
  parseOverlayLines = mod.parseOverlayLines;
});

afterEach(() => {
  delete (globalThis as { Worker?: unknown }).Worker;
});

describe('parseOverlayLines', () => {
  it('returns the vertices the worker sends back', async () => {
    const source = new Uint8Array([1, 2, 3]);
    const promise = parseOverlayLines('grid-lines', source);
    const worker = instances[0];
    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].kind, 'grid-lines');
    assert.equal(worker.posted[0].source, source, 'source passed by reference');

    const verts = new Float32Array([0, 0, 0, 1, 2, 3]);
    worker.reply({ id: worker.posted[0].id, ok: true, verts });
    assert.deepEqual(await promise, verts);
  });

  it('terminates the worker once the last job settles', async () => {
    const promise = parseOverlayLines('grid-lines', new Uint8Array(1));
    const worker = instances[0];
    assert.equal(worker.terminated, 0, 'still running while the job is in flight');
    worker.reply({ id: worker.posted[0].id, ok: true, verts: new Float32Array(0) });
    await promise;
    assert.equal(worker.terminated, 1, 'terminate is what frees the WASM pages');
  });

  it('shares one worker across concurrent jobs and terminates it once', async () => {
    const a = parseOverlayLines('grid-lines', new Uint8Array(1));
    const b = parseOverlayLines('alignment-lines', new Uint8Array(1));
    assert.equal(instances.length, 1, 'one WASM compile, not two');
    const worker = instances[0];
    assert.equal(worker.posted.length, 2);
    assert.notEqual(worker.posted[0].id, worker.posted[1].id, 'ids must be distinct to route replies');

    worker.reply({ id: worker.posted[0].id, ok: true, verts: new Float32Array([1]) });
    await a;
    assert.equal(worker.terminated, 0, 'second job still in flight');

    worker.reply({ id: worker.posted[1].id, ok: true, verts: new Float32Array([2]) });
    await b;
    assert.equal(worker.terminated, 1);
  });

  it('spawns a fresh worker for a later job after the pool went idle', async () => {
    const first = parseOverlayLines('grid-lines', new Uint8Array(1));
    instances[0].reply({ id: instances[0].posted[0].id, ok: true, verts: new Float32Array(0) });
    await first;

    const second = parseOverlayLines('grid-lines', new Uint8Array(1));
    assert.equal(instances.length, 2, 'terminated worker cannot be reused');
    instances[1].reply({ id: instances[1].posted[0].id, ok: true, verts: new Float32Array(0) });
    await second;
    assert.equal(instances[1].terminated, 1);
  });

  it('resolves empty on a parse error rather than rejecting', async () => {
    const promise = parseOverlayLines('grid-lines', new Uint8Array(1));
    const worker = instances[0];
    worker.reply({ id: worker.posted[0].id, ok: false, error: 'boom' });
    assert.equal((await promise).length, 0, 'overlays are decoration; the model must still load');
    assert.equal(worker.terminated, 1, 'a failed job must still free the worker');
  });

  it('settles outstanding jobs when the worker itself errors', async () => {
    const promise = parseOverlayLines('grid-lines', new Uint8Array(1));
    const worker = instances[0];
    worker.onerror?.({ message: 'worker died' });
    assert.equal((await promise).length, 0, 'must not hang forever');
    assert.equal(worker.terminated, 1);
  });

  it('returns empty without spawning anything when Worker is unavailable', async () => {
    delete (globalThis as { Worker?: unknown }).Worker;
    const mod = await import(`./index.js?nw=${Date.now()}${Math.random()}`);
    assert.equal((await mod.parseOverlayLines('grid-lines', new Uint8Array(1))).length, 0);
    assert.equal(instances.length, 0);
  });
});
