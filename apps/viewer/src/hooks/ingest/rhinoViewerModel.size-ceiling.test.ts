/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `.3dm` size ceiling, asked on the main thread before the load copies
 * the archive.
 *
 * Left to the worker, a file over the cap is held twice — the load's own
 * buffer plus the copy the request transfers — for a read that was always
 * going to be refused, and the allocation that fails on the way there is
 * reported as `worker-failed` instead of the size-ceiling message that says
 * what to do about it. CodeRabbit on #9977 (`rhinoViewerModel.ts:246`).
 *
 * Spec: docs/architecture/rhino-3dm-import.md, "Size ceiling" (decision D7).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { diffCounters, perfCounters } from '@ifc-lite/load-trace';
import { MAX_3DM_BYTES } from '@ifc-lite/rhino3dm';
import { RhinoImportError, rhino3dmSizeRefusal } from '@/lib/import/rhino-import-client';
import { installFakeRhinoImportWorker } from '@/test/rhino-import-worker-fake.js';
import { prepareRhinoViewerModel } from './rhinoViewerModel.js';

/** The `copy.*` counters that moved while `run` ran. */
async function copiesDuring(run: () => Promise<unknown>): Promise<string[]> {
  perfCounters.enable();
  const before = perfCounters.read();
  await run();
  return Object.keys(diffCounters(perfCounters.read(), before)).filter(name => name.startsWith('copy.'));
}

/** A real `SharedArrayBuffer` that reports `byteLength` bytes without allocating them. */
function sharedOfLength(byteLength: number): SharedArrayBuffer {
  return Object.defineProperty(new SharedArrayBuffer(8), 'byteLength', { value: byteLength });
}

describe('the .3dm size ceiling', () => {
  it('refuses an oversized archive with the size message, before any copy or worker', async () => {
    // The reader must not be reachable: if it is, the refusal came too late.
    const fake = installFakeRhinoImportWorker({
      read: async () => { throw new Error('the reader was asked for a file already over the cap'); },
    });
    try {
      const error = await prepareRhinoViewerModel(new ArrayBuffer(MAX_3DM_BYTES + 1), 'big.3dm')
        .then(() => null, (reason: unknown) => reason);

      assert.ok(error instanceof RhinoImportError, 'an oversized archive is refused as a Rhino import error');
      // `too-large`, not `worker-failed`: the loader renders the message
      // verbatim and names the code in telemetry.
      assert.equal(error.code, 'too-large');
      assert.equal(error.message, 'This file is 401 MB; the reader handles up to 400 MB. Split the model into smaller files in Rhino.');
      assert.equal(fake.spawned(), 0, 'no import worker is started for a file that is already over the cap');
    } finally {
      fake.restore();
    }
  });

  it('refuses a streamed (shared) archive before unsharing it', async () => {
    // Where cross-origin isolation allows it, a file over 256 MB is streamed
    // into a SharedArrayBuffer. Unsharing it is a full copy; the refusal has
    // to come first.
    const fake = installFakeRhinoImportWorker({
      read: async () => { throw new Error('the reader was asked for a file already over the cap'); },
    });
    try {
      let error: unknown;
      const copied = await copiesDuring(async () => {
        error = await prepareRhinoViewerModel(sharedOfLength(MAX_3DM_BYTES + 1), 'big.3dm').then(() => null, (reason: unknown) => reason);
      });
      assert.ok(error instanceof RhinoImportError);
      assert.equal(error.code, 'too-large');
      assert.deepEqual(copied, [], 'no copy of the archive is made before it is refused');
      assert.equal(fake.spawned(), 0);
    } finally {
      fake.restore();
    }
  });

  it('reports a load cancelled before it starts as a cancel, copying nothing, even over the cap', async () => {
    const controller = new AbortController();
    controller.abort();
    for (const loaded of [new SharedArrayBuffer(16), sharedOfLength(MAX_3DM_BYTES + 1)]) {
      let error: unknown;
      const copied = await copiesDuring(async () => {
        error = await prepareRhinoViewerModel(loaded, 'big.3dm', undefined, controller.signal).then(() => null, (reason: unknown) => reason);
      });
      // What `loadRhino3dmModel` treats as a cancel, as the worker client rejects.
      assert.ok(error instanceof DOMException && error.name === 'AbortError');
      assert.deepEqual(copied, []);
    }
  });

  it('admits an archive exactly at the ceiling', () => {
    // The boundary itself, without allocating it: the cap is inclusive, as
    // the reader's own `bytes.byteLength > MAX_3DM_BYTES` is.
    assert.equal(rhino3dmSizeRefusal(MAX_3DM_BYTES), null);
    assert.equal(rhino3dmSizeRefusal(0), null);
    assert.ok(rhino3dmSizeRefusal(MAX_3DM_BYTES + 1));
  });
});
