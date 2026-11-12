/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The main-thread side of the Rhino export worker: one worker per run,
 * terminated on every way out (success, refusal, crash, abort), and the
 * engine's error text kept intact for NO_RENDER_GEOMETRY matching.
 */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { isNoRenderGeometryError } from '@ifc-lite/geometry';
import { installFakeRhinoWorker, type FakeRhinoWorkerHandle } from '@/test/rhino-export-worker-fake.js';
import {
  __setRhinoExportWorkerFactoryForTest,
  exportRhino3dmInWorker,
  RHINO_EXPORT_TIMEOUT_MS,
  type RhinoExportProgress,
  type RhinoExportWorkerLike,
} from './rhino-export-client.js';

const MANIFEST = JSON.stringify({ warnings: ['w1'], objects: [{}, {}] });
const REQUEST = { content: new Uint8Array([1, 2, 3]), options: { units: 'feet' as const }, version: 8 as const };

let fake: FakeRhinoWorkerHandle | null = null;
afterEach(() => {
  fake?.restore();
  fake = null;
  __setRhinoExportWorkerFactoryForTest(null);
});

describe('exportRhino3dmInWorker', () => {
  it('resolves the bytes and warnings, reports every phase, and terminates the worker', async () => {
    fake = installFakeRhinoWorker({
      buildScene: async () => ({ manifest: MANIFEST, blob: new Uint8Array() }),
      writeScene: async (_s, { onProgress }) => { onProgress(0, 2); onProgress(1, 2); onProgress(2, 2); return { bytes: new Uint8Array([7]), warnings: ['w1'], objectCount: 2 }; },
    });
    const phases: RhinoExportProgress[] = [];
    const result = await exportRhino3dmInWorker(REQUEST, (p) => phases.push(p));
    assert.deepEqual([...result.bytes], [7]);
    assert.deepEqual(result.warnings, ['w1']);
    assert.deepEqual(phases.map((p) => p.phase), ['scene', 'objects', 'objects', 'objects', 'serialize']);
    assert.deepEqual(phases[3], { phase: 'objects', done: 2, total: 2 });
    assert.equal(fake.terminated(), 1);
    assert.deepEqual(fake.requests[0].options, { units: 'feet' });
    assert.equal(fake.requests[0].version, 8);
  });

  it('keeps NO_RENDER_GEOMETRY recognisable across the worker boundary', async () => {
    fake = installFakeRhinoWorker({
      buildScene: async () => { throw new Error('NO_RENDER_GEOMETRY: export produced no render geometry'); },
      writeScene: async () => ({ bytes: new Uint8Array(), warnings: [], objectCount: 1 }),
    });
    await assert.rejects(exportRhino3dmInWorker(REQUEST), (error) => isNoRenderGeometryError(error));
    assert.equal(fake.terminated(), 1);
  });

  it('aborting terminates the worker and rejects with AbortError', async () => {
    fake = installFakeRhinoWorker({
      buildScene: async () => ({ manifest: MANIFEST, blob: new Uint8Array() }),
      writeScene: (_scene, { onProgress }) => { onProgress(0, 2); return new Promise(() => {}); },
    });
    const controller = new AbortController();
    const running = exportRhino3dmInWorker(REQUEST, (p) => { if (p.phase === 'objects') controller.abort(); }, controller.signal);
    await assert.rejects(running, (error) => error instanceof DOMException && error.name === 'AbortError');
    assert.equal(fake.terminated(), 1);
  });

  it('refuses an already-aborted signal without spawning a worker', async () => {
    fake = installFakeRhinoWorker({ buildScene: async () => ({ manifest: MANIFEST, blob: new Uint8Array() }), writeScene: async () => ({ bytes: new Uint8Array(), warnings: [], objectCount: 1 }) });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(exportRhino3dmInWorker(REQUEST, undefined, controller.signal), { name: 'AbortError' });
    assert.equal(fake.spawned(), 0);
  });

  it('a crashed worker rejects and is terminated', async () => {
    let terminated = 0;
    const worker: RhinoExportWorkerLike = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage() { setTimeout(() => worker.onerror?.({ message: 'out of memory' } as ErrorEvent), 0); },
      terminate() { terminated++; },
    };
    __setRhinoExportWorkerFactoryForTest(() => worker);
    await assert.rejects(exportRhino3dmInWorker(REQUEST), /out of memory/);
    assert.equal(terminated, 1);
  });

  // A reply the main thread cannot deserialize must fail the export, never resolve an empty
  // success (revert-oracle mutation evidence on the stack found this unobserved).
  it('an unreadable reply from the worker rejects and terminates it', async () => {
    let terminated = 0;
    const worker: RhinoExportWorkerLike = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage() { setTimeout(() => worker.onmessageerror?.(new MessageEvent('messageerror')), 0); },
      terminate() { terminated++; },
    };
    __setRhinoExportWorkerFactoryForTest(() => worker);
    await assert.rejects(exportRhino3dmInWorker(REQUEST), /unreadable message/);
    assert.equal(terminated, 1);
  });

  it('a worker that cannot start rejects with the reason', async () => {
    __setRhinoExportWorkerFactoryForTest(() => { throw new Error('Worker is not defined'); });
    await assert.rejects(exportRhino3dmInWorker(REQUEST), /Failed to start the Rhino export worker: Worker is not defined/);
  });
});

// inbound decoding failure must reject without waiting for the timeout.
it('rejects worker-wide unreadable-request errors promptly', async () => {
  const { installRhinoExportWorker } = await import('./rhino-export-worker-scope.js');
  let terminated = false;
  __setRhinoExportWorkerFactoryForTest(() => {
    const worker: RhinoExportWorkerLike = {
      onmessage: null, onerror: null, onmessageerror: null,
      terminate() { terminated = true; },
      postMessage() {
        const scope = {
          onmessage: null, onmessageerror: null,
          postMessage(data: unknown) { worker.onmessage?.({ data } as MessageEvent); },
        } as Pick<Worker, 'onmessage' | 'onmessageerror' | 'postMessage'>;
        installRhinoExportWorker(scope, {
          async buildScene() { throw new Error('must not build a scene'); },
          async writeScene() { throw new Error('must not write a scene'); },
        });
        scope.onmessageerror?.call(scope as Worker, new MessageEvent('messageerror'));
      },
    };
    return worker;
  });
  await assert.rejects(exportRhino3dmInWorker(REQUEST), /received an unreadable message/);
  assert.equal(terminated, true);
});

it('progress restarts the liveness timeout; only a silent worker times out', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let live: RhinoExportWorkerLike | null = null;
      let id = 0;
      __setRhinoExportWorkerFactoryForTest(() => {
        live = { onmessage: null, onerror: null, onmessageerror: null, postMessage(m) { id = m.id; }, terminate() {} };
        return live;
      });
      const send = (data: object) => live!.onmessage?.({ data: { id, ...data } } as MessageEvent);
      const busy = exportRhino3dmInWorker(REQUEST);
      const step = RHINO_EXPORT_TIMEOUT_MS * 0.75;
      mock.timers.tick(step);
      send({ type: 'progress', done: 1, total: 2 });
      mock.timers.tick(step); // past one full timeout in total, but never silent that long
      send({ type: 'complete', bytes: new Uint8Array([9]), warnings: [] });
      assert.deepEqual([...(await busy).bytes], [9]);

      const silent = exportRhino3dmInWorker(REQUEST);
      mock.timers.tick(RHINO_EXPORT_TIMEOUT_MS);
      await assert.rejects(silent, /stopped responding/);
    } finally {
      mock.timers.reset();
    }
});
