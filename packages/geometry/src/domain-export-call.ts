/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createLogger } from '@ifc-lite/data';
import type { IfcAPI } from '@ifc-lite/wasm';
import { isNoRenderGeometryError, terrainRefusalReason } from './export-errors.js';

const log = createLogger('Geometry');

/** Shared initialization/error boundary for canonical domain exports. */
export function runDomainExport<T>(
  api: IfcAPI | null, operation: string, content: Uint8Array, run: (api: IfcAPI) => T, onError: (error: unknown) => void,
): T {
  if (!api) throw new Error('IFC-Lite not initialized. Call init() first.');
  try {
    return run(api);
  } catch (error) {
    // A terrain refusal is the exporter's verdict on its input, shown to the
    // user verbatim (#7600); logged as a failure, every preflight of a
    // non-qualifying selection would read as a crash. A typed
    // NO_RENDER_GEOMETRY refusal is the same kind of verdict (#7766).
    if (terrainRefusalReason(error) === null && !isNoRenderGeometryError(error)) {
      log.error(`Failed to ${operation}`, error, { operation, data: { contentLength: content.length } });
    }
    onError(error);
    throw error;
  }
}
