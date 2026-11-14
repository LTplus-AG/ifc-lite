/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rhino (.3dm) import worker. See `lib/import/rhino-import-job.ts` for why the
 * read runs here and for the message protocol.
 *
 * The rhino3dm wasm (2.67 MB) is a Vite asset of this worker chunk only, and
 * the reader imports its runtime lazily. `locateFile` points the emscripten
 * loader at that asset, because the reader's dynamic import does not carry it
 * into the build. Neither this worker nor the export one reaches the viewer's
 * startup graph (`scripts/check-rhino3dm-lazy.mjs`).
 */

import rhinoWasmUrl from 'rhino3dm/rhino3dm.wasm?url';
import type { RhinoImportJobDeps } from '@/lib/import/rhino-import-job';
import { installRhinoImportWorker } from '@/lib/import/rhino-import-worker-scope';

const deps: RhinoImportJobDeps = {
  async read(bytes, options) {
    const { readRhino3dm } = await import('@ifc-lite/rhino3dm');
    return readRhino3dm(bytes, {
      ...options,
      locateFile: (path, prefix) => (path.endsWith('.wasm') ? rhinoWasmUrl : prefix + path),
    });
  },
};

installRhinoImportWorker(self as unknown as Worker, deps);
