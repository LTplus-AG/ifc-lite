/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
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
  onmessageerror: (() => void) | null = null;
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
let parseProfilesFlat: typeof import('./index.js').parseProfilesFlat;
let JOB_TIMEOUT_MS: number;

beforeEach(async () => {
  instances.length = 0;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  // Deterministic deadline test, and it keeps every other test from leaving a
  // 2-minute timer behind that would hold the process open.
  mock.timers.enable({ apis: ['setTimeout'] });
  // Fresh module state per test: the worker handle and the in-flight count
  // are module-level singletons.
  const mod = await import(`./index.js?t=${Date.now()}${Math.random()}`);
  parseOverlayLines = mod.parseOverlayLines;
  parseProfilesFlat = mod.parseProfilesFlat;
  JOB_TIMEOUT_MS = mod.JOB_TIMEOUT_MS;
});

afterEach(() => {
  mock.timers.reset();
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

  // An `error` event is not necessarily fatal: the worker can keep running and
  // deliver the real reply for a job we already settled. If it is left alive,
  // that reply is silently dropped and the next job gets the same sick realm.
  it('kills the worker on error so a late real reply cannot be silently dropped', async () => {
    const a = parseOverlayLines('grid-lines', new Uint8Array(1));
    const b = parseOverlayLines('alignment-lines', new Uint8Array(1));
    const worker = instances[0];
    worker.onerror?.({ message: 'one task threw' });

    // Start the next job SYNCHRONOUSLY, before a and b's `finally` microtasks
    // run. This is the window that matters: if `failAll` did not terminate and
    // null the worker, `inFlight` is still 2 here, so the sick realm would be
    // handed straight to job c and its late replies would be dropped.
    assert.equal(worker.terminated, 1, 'failAll must kill the realm, not wait for refcounting');
    const c = parseOverlayLines('grid-lines', new Uint8Array(1));
    assert.equal(instances.length, 2, 'job c must get a FRESH worker, not the sick one');

    assert.equal((await a).length, 0);
    assert.equal((await b).length, 0);
    instances[1].reply({ id: instances[1].posted[0].id, ok: true, verts: new Float32Array([9]) });
    assert.deepEqual(await c, new Float32Array([9]));
  });

  it('settles on an undeserializable reply (messageerror)', async () => {
    const promise = parseOverlayLines('grid-lines', new Uint8Array(1));
    const worker = instances[0];
    assert.equal(typeof worker.onmessageerror, 'function', 'messageerror must be handled');
    worker.onmessageerror?.();
    assert.equal((await promise).length, 0);
    assert.equal(worker.terminated, 1);
  });

  // The failure mode with no recovery: a worker killed by the OS (OOM on a
  // huge model) fires neither `message` nor `error`.
  it('does not wedge the module when a worker dies silently', async () => {
    const promise = parseOverlayLines('grid-lines', new Uint8Array(1));
    const worker = instances[0];
    mock.timers.tick(JOB_TIMEOUT_MS + 1);
    assert.equal((await promise).length, 0, 'a silent death must still settle');
    assert.equal(worker.terminated, 1, 'the dead worker holds the WASM heap we came to reclaim');

    // And the pool must still be usable afterwards.
    const next = parseOverlayLines('grid-lines', new Uint8Array(1));
    assert.equal(instances.length, 2, 'a wedged inFlight would reuse the dead handle');
    instances[1].reply({ id: instances[1].posted[0].id, ok: true, verts: new Float32Array([1]) });
    assert.deepEqual(await next, new Float32Array([1]));
  });

  it('resolves empty when the Worker constructor throws', async () => {
    (globalThis as { Worker?: unknown }).Worker = function () {
      throw new Error('blocked by CSP');
    };
    const mod = await import(`./index.js?ct=${Date.now()}${Math.random()}`);
    assert.equal((await mod.parseOverlayLines('grid-lines', new Uint8Array(1))).length, 0);
  });

  it('resolves empty when postMessage throws synchronously', async () => {
    class ThrowingWorker extends FakeWorker {
      override postMessage(): void {
        throw new DOMException('could not be cloned', 'DataCloneError');
      }
    }
    (globalThis as { Worker?: unknown }).Worker = ThrowingWorker;
    const mod = await import(`./index.js?pm=${Date.now()}${Math.random()}`);
    assert.equal((await mod.parseOverlayLines('grid-lines', new Uint8Array(1))).length, 0);
    // The worker was constructed, so it must still be freed.
    assert.equal(instances[0].terminated, 1);
  });

  it('a failed start does not strand the in-flight count', async () => {
    (globalThis as { Worker?: unknown }).Worker = function () {
      throw new Error('boom');
    };
    const mod = await import(`./index.js?if=${Date.now()}${Math.random()}`);
    await mod.parseOverlayLines('grid-lines', new Uint8Array(1));
    // If inFlight leaked, the next successful job would never terminate.
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    const promise = mod.parseOverlayLines('grid-lines', new Uint8Array(1));
    const worker = instances[instances.length - 1];
    worker.reply({ id: worker.posted[0].id, ok: true, verts: new Float32Array(0) });
    await promise;
    assert.equal(worker.terminated, 1, 'inFlight must be balanced after a failed start');
  });

  it('returns empty without spawning anything when Worker is unavailable', async () => {
    delete (globalThis as { Worker?: unknown }).Worker;
    const mod = await import(`./index.js?nw=${Date.now()}${Math.random()}`);
    assert.equal((await mod.parseOverlayLines('grid-lines', new Uint8Array(1))).length, 0);
    assert.equal(instances.length, 0);
  });
});

describe('parseProfilesFlat', () => {
  it('asks for the profiles kind and returns the flatten the worker sends', async () => {
    const source = new Uint8Array([1, 2, 3]);
    const promise = parseProfilesFlat(source);
    const worker = instances[0];
    assert.equal(worker.posted[0].kind, 'profiles');
    assert.equal(worker.posted[0].source, source, 'source passed by reference');

    // Assert the FIELDS survive, not that the same object came back: object
    // identity would hold even if the client dropped or reshaped the payload.
    const profiles = {
      typeNames: ['IfcWall'],
      typeIndex: new Uint16Array([0]),
      expressId: new Uint32Array([42]),
      outerPoints: new Float32Array([1, 2, 3, 4]),
      outerStart: new Uint32Array([0, 4]),
      extrusionDepth: new Float32Array([2.5]),
    };
    worker.reply({ id: worker.posted[0].id, ok: true, profiles });
    const got = await promise;
    assert.deepEqual(got.typeNames, ['IfcWall']);
    assert.deepEqual([...got.expressId], [42]);
    assert.deepEqual([...got.outerPoints], [1, 2, 3, 4]);
    assert.deepEqual([...got.outerStart], [0, 4]);
    assert.deepEqual([...got.extrusionDepth], [2.5]);
    assert.equal(worker.terminated, 1, 'terminate is what frees the WASM pages');
  });

  // Construction projection is decoration too: a model that cannot produce
  // profiles must still draw, so every failure resolves to an empty flatten
  // rather than rejecting or handing back undefined.
  it('resolves to an EMPTY flatten on a parse error, not a rejection', async () => {
    const promise = parseProfilesFlat(new Uint8Array(1));
    const worker = instances[0];
    worker.reply({ id: worker.posted[0].id, ok: false, error: 'boom' });
    const flat = await promise;
    assert.equal(flat.expressId.length, 0);
    assert.deepEqual(flat.typeNames, []);
    // The `N + 1` offset arrays must still have their leading zero, or the
    // rebuild would read `undefined` bounds instead of producing nothing.
    assert.equal(flat.outerStart.length, 1);
    assert.equal(flat.holeCountStart.length, 1);
    assert.equal(flat.holePointStart.length, 1);
    assert.equal(worker.terminated, 1, 'a failed job must still free the worker');
  });

  it('resolves to an empty flatten when the worker dies silently', async () => {
    const promise = parseProfilesFlat(new Uint8Array(1));
    mock.timers.tick(JOB_TIMEOUT_MS + 1);
    assert.equal((await promise).expressId.length, 0);
    assert.equal(instances[0].terminated, 1);
  });

  // Each empty resolution must own its buffers: a shared module-level constant
  // would be handed to two callers, and one mutating it would corrupt the other.
  it('gives each empty resolution its own arrays', async () => {
    const a = parseProfilesFlat(new Uint8Array(1));
    const b = parseProfilesFlat(new Uint8Array(1));
    const worker = instances[0];
    worker.reply({ id: worker.posted[0].id, ok: false, error: 'boom' });
    worker.reply({ id: worker.posted[1].id, ok: false, error: 'boom' });
    const [first, second] = await Promise.all([a, b]);
    assert.notEqual(first, second);
    assert.notEqual(first.outerStart.buffer, second.outerStart.buffer);
    assert.notEqual(first.typeNames, second.typeNames);
  });
});
