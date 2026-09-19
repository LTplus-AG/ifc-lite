/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { captureModelLoaded, snapshotFromGeometry } from '../../utils/loadTelemetry.js';
import { toast } from '../../components/ui/toast.js';
import { parseLandXmlViewerModelAsync, type LandXmlViewerModel } from './landXmlViewerModel.js';

interface LandXmlLoadOptions {
  buffer: ArrayBuffer;
  fileSizeMB: number;
  targetKind: 'primary' | 'federated';
  totalStartTime: number;
  wasHidden: boolean;
  isCurrent(): boolean;
  setProgress(progress: { phase: string; percent: number }): void;
  setGeometryStreamingActive(active: boolean): void;
  setLoading(loading: boolean): void;
  onPrimary(result: LandXmlViewerModel): void;
  finalize(
    dataStore: IfcDataStore,
    geometry: GeometryResult,
    schemaVersion: 'IFC4',
    patch: { loadPath: 'landxml' },
  ): Promise<void>;
  onError(message: string): void;
}

/** Own the format-specific branch while `loadFile` retains lifecycle ownership. */
export async function loadLandXmlModel(options: LandXmlLoadOptions): Promise<void> {
  options.setProgress({ phase: 'Parsing LandXML TIN surfaces', percent: 10 });
  options.setGeometryStreamingActive(false);
  try {
    const result = await parseLandXmlViewerModelAsync(options.buffer);
    if (!options.isCurrent()) return;
    if (options.targetKind === 'primary') options.onPrimary(result);
    await options.finalize(result.dataStore, result.geometryResult, result.schemaVersion, { loadPath: 'landxml' });
    if (!options.isCurrent()) return;
    for (const warning of result.warnings) toast.info(warning);
    options.setProgress({ phase: 'Complete', percent: 100 });
    captureModelLoaded({
      format: 'landxml',
      file_size_mb: Math.round(options.fileSizeMB * 100) / 100,
      load_target: options.targetKind,
      load_path: 'landxml',
      total_elapsed_ms: Math.round(performance.now() - options.totalStartTime),
      was_hidden: options.wasHidden,
    }, snapshotFromGeometry(options.fileSizeMB, result.geometryResult));
    options.setLoading(false);
  } catch (error) {
    if (!options.isCurrent()) return;
    console.error('[useIfc] LandXML parsing failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    options.onError(message);
    options.setLoading(false);
  }
}
