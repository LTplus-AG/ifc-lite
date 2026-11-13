/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `loadFile` branch for a Rhino `.3dm`: read it in the import worker,
 * adapt it, and hand it to the one `finalizeModel` every format goes through.
 *
 * It lives beside `landXmlLoad.ts` rather than inside `useIfcLoader.ts` for
 * the same reason that one does — the hook is at its module-size budget — and
 * `loadFile` reaches it through a dynamic import, which also keeps the import
 * client and the adapter out of the viewer's eager startup chunks.
 *
 * Spec: docs/architecture/rhino-3dm-import.md.
 */

import type { LoadTrace } from '@ifc-lite/load-trace';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { captureModelLoaded, snapshotFromGeometry } from '../../utils/loadTelemetry.js';
import { LOAD_COMPLETE } from '../modelLoadCanceller.js';
import { RhinoImportError } from '../../lib/import/rhino-import-client.js';
import { prepareRhinoViewerModel } from './rhinoViewerModel.js';
import type { ViewerModelPayload } from './viewerModelIngest.js';

export interface RhinoLoadOptions {
  /** The load's own source buffer, as loaded. It becomes the store's `source`, unshared first if it is a `SharedArrayBuffer`. */
  buffer: ArrayBuffer | SharedArrayBuffer;
  fileSizeMB: number;
  targetKind: 'primary' | 'federated';
  totalStartTime: number;
  wasHidden: boolean;
  /** The load's trace: `ifc_model_loaded` reads its field properties off it (#6961). */
  trace: LoadTrace;
  /** Aborted when the load is cancelled; it terminates the worker mid-read. */
  signal: AbortSignal;
  isStale(): boolean;
  setProgress(progress: { phase: string; percent: number }): void;
  /** Ends this load's share of the shared load UI, with its terminal progress. */
  settleLoadUi(progress?: { phase: string; percent: number } | null): void;
  onPrimary(result: ViewerModelPayload): void;
  finalize(
    dataStore: IfcDataStore,
    geometry: GeometryResult,
    schemaVersion: 'IFC4',
    patch: { loadPath: '3dm' },
  ): Promise<void>;
  /**
   * Records the failure. `message` is what the user reads (the model record's
   * `loadError` is rendered verbatim in the hierarchy panel); `code` is for
   * the failure's telemetry name.
   */
  onError(code: string, message: string): void;
}

export async function loadRhino3dmModel(options: RhinoLoadOptions): Promise<void> {
  const { isStale, setProgress, settleLoadUi } = options;
  setProgress({ phase: 'Reading Rhino .3dm', percent: 10 });
  try {
    const result = await prepareRhinoViewerModel(options.buffer, setProgress, options.signal);
    // Stale-guard-after-await (as on the IFCX branch): the read is the only
    // await here and a newer load may have superseded this one while it ran.
    // Nothing was acquired before this point, so there is nothing to unwind.
    if (isStale()) return;
    if (options.targetKind === 'primary') options.onPrimary(result);
    await options.finalize(result.dataStore, result.geometryResult, 'IFC4', { loadPath: '3dm' });
    if (isStale()) return;
    captureModelLoaded({
      format: '3dm', file_size_mb: Math.round(options.fileSizeMB * 100) / 100, load_target: options.targetKind,
      load_path: '3dm', total_elapsed_ms: Math.round(performance.now() - options.totalStartTime), was_hidden: options.wasHidden,
    }, snapshotFromGeometry(options.fileSizeMB, result.geometryResult), options.trace);
    settleLoadUi(LOAD_COMPLETE);
  } catch (error: unknown) {
    if (isStale()) return;
    // A cancelled load already settled its own UI through the canceller.
    if (error instanceof DOMException && error.name === 'AbortError') {
      settleLoadUi();
      return;
    }
    console.error('[useIfc] Rhino .3dm reading failed:', error);
    // The reader's messages are user-facing and say what to do (damaged file,
    // saved by a newer Rhino, over the size cap), so they are shown as they
    // are rather than wrapped in a second sentence.
    const code = error instanceof RhinoImportError ? error.code : 'worker-failed';
    options.onError(code, error instanceof Error ? error.message : String(error));
    settleLoadUi();
  }
}
