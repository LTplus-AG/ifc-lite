/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The loader's side of the small-file fast path: a geometry run a spare worker
 * started at the pick (lib/fast-path/fastPathRuntime.ts, loaded lazily), which
 * the load claims at its geometry stage instead of starting its own pipeline.
 *
 * The worker makes the same `processAdaptive` call the load would make
 * (adaptiveGeometryOptions.ts), so its events are the load's events. A run is
 * used only when:
 * - it meshed with exactly the settings the load would mesh with now,
 * - the load is the primary load the run was started for, and
 * - the bytes the load will parse are the picked file's own bytes (not an
 *   archive the loader unwrapped).
 * Otherwise the claim returns `null` and the normal pipeline runs. A run that
 * fails before its first event falls back to the normal pipeline; after the
 * first event, a failure ends the stream like a failure of the worker pool.
 */

import type { GeometryMeshingSettings, StreamingGeometryEvent } from '@ifc-lite/geometry';

export interface FastGeometryRun {
  readonly file: File;
  readonly settings: GeometryMeshingSettings;
  /** The run's events, in order; one consumer. Rejects on a worker error or a missing first event. */
  readonly events: AsyncIterable<StreamingGeometryEvent>;
  /** Stop the run and its worker (no-op once settled). */
  cancel(): void;
}

export interface FastClaim {
  /** The load's target kind; only a primary load may use a run. */
  target: 'primary' | 'federated';
  /** True when the bytes the load will parse are the picked File's bytes (no archive unwrapped). */
  sourceIsFile: boolean;
}

type Claimer = (file: File, settings: GeometryMeshingSettings, claim: FastClaim) => FastGeometryRun | null;
let claimer: Claimer | null = null;

/** Installed by the fast-path runtime once it is ready; returns the uninstall function. */
export function setFastGeometryClaimer(next: Claimer): () => void {
  claimer = next;
  return () => { if (claimer === next) claimer = null; };
}

/** The run started at the pick for this load, or `null`. */
export function claimFastGeometry(file: File, settings: GeometryMeshingSettings, claim: FastClaim): FastGeometryRun | null {
  return claimer?.(file, settings, claim) ?? null;
}

/** Same settings, field by field (a run meshed with other settings would not be the same geometry). */
export function sameMeshingSettings(a: GeometryMeshingSettings, b: GeometryMeshingSettings): boolean {
  return a.mergeLayers === b.mergeLayers && a.enableInstancing === b.enableInstancing
    && (a.tessellationQuality ?? null) === (b.tessellationQuality ?? null)
    && a.skipSmallCuts === b.skipSmallCuts && a.skipVoids === b.skipVoids
    && (a.geometryHashTolerance ?? null) === (b.geometryHashTolerance ?? null);
}

function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {}); // abandoned: the cancel that follows rejects it, and nobody else awaits it
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * The run's events. Before the first event, a failure (or an empty run) switches
 * to `fallback()`, whose own first event re-arms the loader's stall watchdog.
 * An abort of the load cancels the run and ends the stream with the abort.
 */
export async function* fastGeometryEvents(
  run: FastGeometryRun,
  fallback: () => AsyncIterable<StreamingGeometryEvent>,
  signal?: AbortSignal,
): AsyncGenerator<StreamingGeometryEvent> {
  const it = run.events[Symbol.asyncIterator]();
  let first: IteratorResult<StreamingGeometryEvent>;
  try {
    first = await untilAborted(it.next(), signal);
    if (first.done) throw new Error('fast-path run ended without events');
  } catch (err) {
    run.cancel();
    if (signal?.aborted) throw err;
    console.warn('[fast-path] spare worker failed; meshing with the normal pipeline:', err);
    yield* fallback();
    return;
  }
  try {
    yield first.value;
    for (;;) {
      const next = await untilAborted(it.next(), signal);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    run.cancel(); // no-op once the run ended; stops it when the consumer stops early
  }
}
