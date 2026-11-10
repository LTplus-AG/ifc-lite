/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Rhino export worker's job: phase order (scene, objects, serialize),
 * throttled progress, manifest warnings, and the engine's error text passed
 * through verbatim so the dialog can recognise NO_RENDER_GEOMETRY.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runRhinoExportJob,
  type RhinoExportJobDeps,
  type RhinoExportWorkerRequest,
  type RhinoExportWorkerResponse,
} from './rhino-export-job.js';

const REQUEST: RhinoExportWorkerRequest = {
  type: 'export', id: 7, content: new Uint8Array([1, 2, 3]), options: { units: 'meters' }, version: 7,
};

function manifest(objects: number, warnings: string[] = []): string {
  return JSON.stringify({ format: 'ifc-lite.rhino-scene', version: 1, warnings, objects: Array.from({ length: objects }, () => ({})) });
}

async function run(deps: RhinoExportJobDeps) {
  const messages: RhinoExportWorkerResponse[] = [];
  const transfers: (Transferable[] | undefined)[] = [];
  await runRhinoExportJob(REQUEST, (m, t) => { messages.push(m); transfers.push(t); }, deps);
  return { messages, transfers };
}

describe('runRhinoExportJob', () => {
  it('runs scene build, object progress, serialize, then completes with the warnings', async () => {
    const seen: { content?: Uint8Array; options?: unknown; version?: number } = {};
    const { messages, transfers } = await run({
      async buildScene(content, options) {
        seen.content = content; seen.options = options;
        return { manifest: manifest(1000, ['length unit scale 0.5 is not a Rhino unit; wrote Meters']), blob: new Uint8Array(8) };
      },
      async writeScene(_scene, { version, onProgress }) {
        seen.version = version;
        onProgress(0, 1000);
        for (let i = 1; i <= 1000; i++) onProgress(i, 1000);
        return { bytes: new Uint8Array([9, 9]), warnings: ['length unit scale 0.5 is not a Rhino unit; wrote Meters'], objectCount: 2 };
      },
    });
    assert.deepEqual(seen.content, REQUEST.content);
    assert.deepEqual(seen.options, { units: 'meters' });
    assert.equal(seen.version, 7, 'the adapter gets the requested archive version');

    assert.deepEqual(messages[0], { type: 'phase', id: 7, phase: 'scene' });
    assert.deepEqual(messages[1], { type: 'progress', id: 7, done: 0, total: 1000 });
    const progress = messages.filter((m) => m.type === 'progress');
    assert.ok(progress.length <= 102, `progress is throttled to one per percent, saw ${progress.length}`);
    assert.deepEqual(progress.at(-1), { type: 'progress', id: 7, done: 1000, total: 1000 });
    const serializeAt = messages.findIndex((m) => m.type === 'phase' && m.phase === 'serialize');
    assert.ok(serializeAt > messages.indexOf(progress.at(-1)!), 'serialize follows the last object');
    const last = messages.at(-1)!;
    assert.equal(last.type, 'complete');
    if (last.type !== 'complete') return;
    assert.deepEqual([...last.bytes], [9, 9]);
    assert.deepEqual(last.warnings, ['length unit scale 0.5 is not a Rhino unit; wrote Meters']);
    assert.deepEqual(transfers.at(-1), [last.bytes.buffer], 'the result buffer is transferred, not cloned');
  });

  it('copies a result that is a view into a larger buffer before transferring it', async () => {
    const heap = new Uint8Array(64);
    heap.set([4, 5, 6], 10);
    const { messages, transfers } = await run({
      buildScene: async () => ({ manifest: manifest(1), blob: new Uint8Array() }),
      writeScene: async () => ({ bytes: heap.subarray(10, 13), warnings: [], objectCount: 1 }),
    });
    const last = messages.at(-1)!;
    assert.equal(last.type, 'complete');
    if (last.type !== 'complete') return;
    assert.deepEqual([...last.bytes], [4, 5, 6]);
    assert.notEqual(last.bytes.buffer, heap.buffer, 'the larger buffer is never transferred');
    assert.equal(heap.byteLength, 64, 'the source buffer stays attached');
    assert.deepEqual(transfers.at(-1), [last.bytes.buffer]);
  });

  it('passes the engine error through verbatim and stops', async () => {
    const code = 'NO_RENDER_GEOMETRY: export produced no render geometry (empty model or all meshes filtered out)';
    let wrote = false;
    const { messages } = await run({
      buildScene: async () => { throw new Error(code); },
      writeScene: async () => { wrote = true; return { bytes: new Uint8Array(), warnings: ['length unit scale 0.5 is not a Rhino unit; wrote Meters'], objectCount: 2 }; },
    });
    assert.equal(wrote, false, 'nothing is written after a refused scene');
    assert.deepEqual(messages.at(-1), { type: 'error', id: 7, message: code });
    assert.equal(messages.filter((m) => m.type === 'error' || m.type === 'complete').length, 1, 'exactly one terminal message');
  });

  it('reports a writer failure as an error, not a rejection', async () => {
    const { messages } = await run({
      buildScene: async () => ({ manifest: manifest(2), blob: new Uint8Array() }),
      writeScene: async () => { throw new Error('3dm version must be 7 or 8'); },
    });
    assert.deepEqual(messages.at(-1), { type: 'error', id: 7, message: '3dm version must be 7 or 8' });
  });
});
