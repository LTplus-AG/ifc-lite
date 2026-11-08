/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rhino (.3dm) export worker. See `lib/export/rhino-export-job.ts` for why the
 * whole export runs here and for the message protocol.
 *
 * The rhino3dm wasm (2.67 MB) is a Vite asset of this worker chunk only, and
 * the adapter imports its runtime lazily, so neither reaches the viewer's
 * startup graph. `locateFile` points the emscripten loader at that asset,
 * because the adapter's dynamic import does not carry it into the build.
 */

import rhinoWasmUrl from 'rhino3dm/rhino3dm.wasm?url';
import type { RhinoExportJobDeps } from '@/lib/export/rhino-export-job';
import { installRhinoExportWorker } from '@/lib/export/rhino-export-worker-scope';

const deps: RhinoExportJobDeps = {
  async buildScene(content, options) {
    const { GeometryProcessor } = await import('@ifc-lite/geometry');
    const processor = new GeometryProcessor();
    try {
      await processor.init();
      return processor.exportRhinoScene(content, options);
    } finally {
      processor.dispose();
    }
  },
  async writeScene(scene, { version, onProgress }) {
    const { writeRhino3dm } = await import('@ifc-lite/rhino3dm');
    return writeRhino3dm(scene, {
      version,
      onProgress,
      locateFile: (path, prefix) => (path.endsWith('.wasm') ? rhinoWasmUrl : prefix + path),
    });
  },
};

installRhinoExportWorker(self as unknown as Worker, deps);
