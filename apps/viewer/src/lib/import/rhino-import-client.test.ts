/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The main-thread side of the Rhino import worker: one worker per run,
 * terminated on every way out (success, refusal, crash, abort), the reader's
 * error code carried across the boundary, and the axis swap done before the
 * result arrives.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RhinoImport } from '@ifc-lite/rhino3dm';
import { installFakeRhinoImportWorker, type FakeRhinoImportWorkerHandle } from '@/test/rhino-import-worker-fake.js';
import {
  __setRhinoImportWorkerFactoryForTest,
  readRhino3dmInWorker,
  RhinoImportError,
  type RhinoImportProgress,
  type RhinoImportWorkerLike,
} from './rhino-import-client.js';

/** One Z-up mesh at a known point, the shape `readRhino3dm` returns. */
function readerResult(): RhinoImport {
  return {
    format: 'ifc-lite.rhino-import',
    version: 1,
    document: {
      archiveVersion: 80, application: '', unitSystem: 'Meters', metersPerUnit: 1,
      provenance: 'rhino', frame: 'file', earthAnchor: null, strings: [],
    },
    layers: [{ name: 'Default', fullPath: 'Default', parent: null, color: [0, 0, 0, 255], visible: true, userStrings: [], spatial: null }],
    entities: [{
      globalId: '2XPyKWY018sA1ygZKgQPtU', ifcClass: 'IfcWall', name: '', description: '', objectType: '',
      layer: 0, hidden: false, objectIds: [], geometryType: 'Mesh', userStrings: [], propertySets: [],
    }],
    meshes: [{
      entity: 0, color: [1, 1, 1, 1], origin: [1, 2, 3],
      positions: new Float32Array([0, 0, 0, 1, 2, 3]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 0, 0]),
    }],
    definitions: [], instances: [], pointClouds: [], curves: [], textDots: [],
    skipped: {}, warnings: [],
  };
}

/** The reader's own error, by shape: the job must not need its class. */
function readerError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = 'RhinoReadError';
  error.code = code;
  return error;
}

const bytes = () => new Uint8Array([1, 2, 3, 4]);

let fake: FakeRhinoImportWorkerHandle | null = null;
afterEach(() => {
  fake?.restore();
  fake = null;
  __setRhinoImportWorkerFactoryForTest(null);
});

describe('readRhino3dmInWorker', () => {
  it('resolves the axis-swapped result, reports progress, and terminates the worker', async () => {
    fake = installFakeRhinoImportWorker({
      read: async (_bytes, options) => {
        options.onProgress?.(0, 2);
        options.onProgress?.(1, 2);
        options.onProgress?.(2, 2);
        return readerResult();
      },
    });
    const progress: RhinoImportProgress[] = [];
    const result = await readRhino3dmInWorker(bytes(), (p) => progress.push(p));

    assert.deepEqual(progress, [{ done: 0, total: 2 }, { done: 1, total: 2 }, { done: 2, total: 2 }]);
    // x, y, z -> x, z, -y, on the origin and on every vertex and normal.
    assert.deepEqual(result.meshes[0].origin, [1, 3, -2]);
    assert.deepEqual([...result.meshes[0].positions], [0, 0, 0, 1, 3, -2]);
    assert.deepEqual([...result.meshes[0].normals], [0, 1, 0, 0, 1, 0]);
    assert.equal(fake.terminated(), 1);
  });

  it('asks the reader to bake blocks and transfers the bytes it was given', async () => {
    let baked: boolean | undefined;
    fake = installFakeRhinoImportWorker({
      read: async (_bytes, options) => { baked = options.bakeInstances; return readerResult(); },
    });
    const input = bytes();
    await readRhino3dmInWorker(input);

    assert.equal(baked, true, 'no GPU instance path yet (decision D4)');
    assert.deepEqual([...fake.requests[0].bytes], [1, 2, 3, 4]);
    assert.equal(input.byteLength, 0, 'the request transferred the bytes, so the caller view is detached');
  });

  it('keeps the reader code and message across the worker boundary', async () => {
    fake = installFakeRhinoImportWorker({
      read: async () => { throw readerError('too-large', 'This file is 512 MB; the reader handles up to 400 MB.'); },
    });

    await assert.rejects(readRhino3dmInWorker(bytes()), (error: unknown) => {
      assert.ok(error instanceof RhinoImportError);
      assert.equal(error.code, 'too-large');
      assert.equal(error.message, 'This file is 512 MB; the reader handles up to 400 MB.');
      return true;
    });
    assert.equal(fake.terminated(), 1);
  });

  it('reports a failure that is not the reader as worker-failed', async () => {
    fake = installFakeRhinoImportWorker({ read: async () => { throw new TypeError('x is not a function'); } });

    await assert.rejects(readRhino3dmInWorker(bytes()),
      (error: unknown) => error instanceof RhinoImportError && error.code === 'worker-failed');
    assert.equal(fake.terminated(), 1);
  });

  it('aborting terminates the worker and rejects with AbortError', async () => {
    fake = installFakeRhinoImportWorker({
      read: (_bytes, options) => { options.onProgress?.(0, 2); return new Promise(() => {}); },
    });
    const controller = new AbortController();
    const running = readRhino3dmInWorker(bytes(), () => controller.abort(), controller.signal);

    await assert.rejects(running, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    assert.equal(fake.terminated(), 1);
  });

  it('refuses an already-aborted signal without spawning a worker', async () => {
    fake = installFakeRhinoImportWorker({ read: async () => readerResult() });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(readRhino3dmInWorker(bytes(), undefined, controller.signal), { name: 'AbortError' });
    assert.equal(fake.spawned(), 0);
  });

  it('a crashed worker rejects and is terminated', async () => {
    let terminated = 0;
    const worker: RhinoImportWorkerLike = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage: () => setTimeout(() => worker.onerror?.({ message: 'out of memory' } as ErrorEvent), 0),
      terminate: () => { terminated++; },
    };
    __setRhinoImportWorkerFactoryForTest(() => worker);

    await assert.rejects(readRhino3dmInWorker(bytes()), (error: unknown) =>
      error instanceof RhinoImportError && error.code === 'worker-failed' && error.message === 'out of memory');
    assert.equal(terminated, 1);
  });

  it('an unreadable message rejects rather than hanging', async () => {
    let terminated = 0;
    const worker: RhinoImportWorkerLike = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage: () => setTimeout(() => worker.onmessageerror?.({} as MessageEvent), 0),
      terminate: () => { terminated++; },
    };
    __setRhinoImportWorkerFactoryForTest(() => worker);

    await assert.rejects(readRhino3dmInWorker(bytes()), /unreadable message/);
    assert.equal(terminated, 1);
  });
});
