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

import {
  MAX_3DM_IMPORT_BYTES,
  RhinoImportError,
  rhino3dmSizeRefusal,
} from '@/lib/import/rhino-import-client';
import { installFakeRhinoImportWorker } from '@/test/rhino-import-worker-fake.js';
import { prepareRhinoViewerModel } from './rhinoViewerModel.js';

describe('the .3dm size ceiling', () => {
  it('refuses an oversized archive with the size message, before any copy or worker', async () => {
    // The reader must not be reachable: if it is, the refusal came too late.
    const fake = installFakeRhinoImportWorker({
      read: async () => { throw new Error('the reader was asked for a file already over the cap'); },
    });
    try {
      const error = await prepareRhinoViewerModel(new ArrayBuffer(MAX_3DM_IMPORT_BYTES + 1))
        .then(() => null, (reason: unknown) => reason);

      assert.ok(error instanceof RhinoImportError, 'an oversized archive is refused as a Rhino import error');
      // `too-large`, not `worker-failed`: the loader renders the message
      // verbatim and names the code in telemetry.
      assert.equal(error.code, 'too-large');
      assert.match(error.message, /the reader handles up to 400 MB\. Split the model into smaller files in Rhino\./);
      assert.equal(fake.spawned(), 0, 'no import worker is started for a file that is already over the cap');
    } finally {
      fake.restore();
    }
  });

  it('admits an archive exactly at the ceiling', () => {
    // The boundary itself, without allocating it: the cap is inclusive, as
    // the reader's own `bytes.byteLength > MAX_3DM_BYTES` is.
    assert.equal(rhino3dmSizeRefusal(MAX_3DM_IMPORT_BYTES), null);
    assert.equal(rhino3dmSizeRefusal(0), null);
    assert.ok(rhino3dmSizeRefusal(MAX_3DM_IMPORT_BYTES + 1));
  });
});
