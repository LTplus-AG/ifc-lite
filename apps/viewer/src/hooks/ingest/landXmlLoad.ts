/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { federationFrameInfo, ifcToViewerAxes, totalYupOffset } from '@ifc-lite/geometry/world-frame';
import { captureModelLoaded, snapshotFromGeometry } from '../../utils/loadTelemetry.js';
import { toast } from '../../components/ui/toast.js';
import { useViewerStore } from '../../store/index.js';
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

function shiftBounds(
  bounds: CoordinateInfo['originalBounds'],
  offset: Readonly<{ x: number; y: number; z: number }>,
): CoordinateInfo['originalBounds'] {
  return {
    min: { x: bounds.min.x - offset.x, y: bounds.min.y - offset.y, z: bounds.min.z - offset.z },
    max: { x: bounds.max.x - offset.x, y: bounds.max.y - offset.y, z: bounds.max.z - offset.z },
  };
}

/** Move parsed LandXML into the federation's already-published render frame. */
export function reframeLandXmlGeometry(geometry: GeometryResult, frame: CoordinateInfo): void {
  const ownOffset = totalYupOffset(geometry.coordinateInfo);
  const targetOffset = totalYupOffset(frame);
  const delta = {
    x: ownOffset.x - targetOffset.x,
    y: ownOffset.y - targetOffset.y,
    z: ownOffset.z - targetOffset.z,
  };
  for (const mesh of geometry.meshes) {
    const origin = mesh.origin ?? [0, 0, 0];
    mesh.origin = [origin[0] + delta.x, origin[1] + delta.y, origin[2] + delta.z];
  }
  const worldBounds = geometry.coordinateInfo.originalBounds;
  const rtcYup = ifcToViewerAxes(frame.wasmRtcOffset ?? { x: 0, y: 0, z: 0 });
  geometry.coordinateInfo = {
    ...geometry.coordinateInfo,
    originShift: { ...frame.originShift },
    originalBounds: shiftBounds(worldBounds, rtcYup),
    shiftedBounds: shiftBounds(worldBounds, targetOffset),
    wasmRtcOffset: frame.wasmRtcOffset ? { ...frame.wasmRtcOffset } : undefined,
    wasmRtcFrame: frame.wasmRtcFrame ? { ...frame.wasmRtcFrame } : undefined,
  };
}

/** Own the format-specific branch while `loadFile` retains lifecycle ownership. */
export async function loadLandXmlModel(options: LandXmlLoadOptions): Promise<void> {
  options.setProgress({ phase: 'Parsing LandXML TIN surfaces', percent: 10 });
  options.setGeometryStreamingActive(false);
  try {
    const result = await parseLandXmlViewerModelAsync(options.buffer);
    if (!options.isCurrent()) return;
    const frame = options.targetKind === 'federated'
      ? federationFrameInfo(useViewerStore.getState().models.values())
      : null;
    if (frame) reframeLandXmlGeometry(result.geometryResult, frame);
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
