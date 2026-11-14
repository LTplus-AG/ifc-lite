/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What one fast-path run does with the picked file: refuse anything that is not
 * a STEP source, then make the SAME `processAdaptive` call the loader makes
 * (`adaptiveGeometryOptions`), with the load's meshing settings. Below 2 MiB
 * that is the single-session branch; from 2 MiB the worker pool with GPU
 * instancing. Shared by the spare worker (fast-geometry.worker.ts) and the
 * loader tests, so both run exactly this code.
 */

import { GeometryProcessor, type GeometryMeshingSettings, type StreamingGeometryEvent } from '@ifc-lite/geometry';
import { adaptiveGeometryOptions } from '../hooks/ingest/adaptiveGeometryOptions.js';
import { looksLikeStepSource } from '../hooks/ingest/stepSource.js';

const MIB = 1024 * 1024;

export async function* fastRunEvents(
  bytes: Uint8Array,
  settings: GeometryMeshingSettings,
  workerCountOverride: number | undefined,
  signal: AbortSignal,
): AsyncGenerator<StreamingGeometryEvent> {
  if (!looksLikeStepSource(bytes)) throw new Error('not an IFC STEP source');
  const processor = new GeometryProcessor({
    preferNative: false,
    mergeLayers: settings.mergeLayers,
    enableInstancing: settings.enableInstancing,
    tessellationQuality: settings.tessellationQuality ?? undefined,
    skipSmallCuts: settings.skipSmallCuts,
    skipVoids: settings.skipVoids,
  });
  try {
    await processor.init();
    if (settings.geometryHashTolerance !== null) processor.enableGeometryHashes(settings.geometryHashTolerance);
    yield* processor.processAdaptive(bytes, adaptiveGeometryOptions({ fileSizeMB: bytes.byteLength / MIB, workerCountOverride, signal }));
  } finally {
    processor.dispose();
  }
}
