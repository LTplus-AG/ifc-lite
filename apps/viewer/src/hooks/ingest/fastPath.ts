/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The loader's side of the small-file fast path: a geometry run a spare worker
 * started at the pick (lib/fast-path/fastPathRuntime.ts, loaded lazily), which
 * the load claims at its geometry stage instead of starting the worker pool.
 *
 * A run is used only when it meshed with exactly the settings the load would
 * mesh with now; otherwise it is cancelled and the normal pipeline runs. If the
 * run fails or times out, the load falls back to the normal pipeline with the
 * bytes it already holds. The run's events are the same `StreamingGeometryEvent`s
 * the single-session path yields, delivered once.
 */

import type { GeometryMeshingSettings, StreamingGeometryEvent } from '@ifc-lite/geometry';

export interface FastGeometryRun {
  readonly file: File;
  readonly settings: GeometryMeshingSettings;
  /** Every event of the run; rejects on a worker error or timeout. */
  readonly events: Promise<StreamingGeometryEvent[]>;
  /** Stop the run and its worker (no-op once settled). */
  cancel(): void;
}

type Claimer = (file: File, settings: GeometryMeshingSettings) => FastGeometryRun | null;
let claimer: Claimer | null = null;

/** Installed by the fast-path runtime once it is ready; returns the uninstall function. */
export function setFastGeometryClaimer(next: Claimer): () => void {
  claimer = next;
  return () => { if (claimer === next) claimer = null; };
}

/** The run started at the pick for this file and these settings, or `null`. */
export function claimFastGeometry(file: File, settings: GeometryMeshingSettings): FastGeometryRun | null {
  return claimer?.(file, settings) ?? null;
}

/** Same settings, field by field (a run meshed with other settings would not be the same geometry). */
export function sameMeshingSettings(a: GeometryMeshingSettings, b: GeometryMeshingSettings): boolean {
  return a.mergeLayers === b.mergeLayers && a.enableInstancing === b.enableInstancing
    && (a.tessellationQuality ?? null) === (b.tessellationQuality ?? null)
    && a.skipSmallCuts === b.skipSmallCuts && a.skipVoids === b.skipVoids
    && (a.geometryHashTolerance ?? null) === (b.geometryHashTolerance ?? null);
}

/**
 * The run's events, or, if the run fails, the normal pipeline's. An abort of
 * the load cancels the run and ends the stream with the abort.
 */
export async function* fastGeometryEvents(
  run: FastGeometryRun,
  fallback: () => AsyncIterable<StreamingGeometryEvent>,
  signal?: AbortSignal,
): AsyncGenerator<StreamingGeometryEvent> {
  let events: StreamingGeometryEvent[];
  try {
    events = await new Promise<StreamingGeometryEvent[]>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const onAbort = () => reject(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      run.events.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
    });
  } catch (err) {
    run.cancel();
    if (signal?.aborted) throw err;
    console.warn('[fast-path] spare worker failed; meshing with the normal pipeline:', err);
    yield* fallback();
    return;
  }
  yield* events;
}
