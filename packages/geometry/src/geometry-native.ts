/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Native Tauri bridge streaming helpers.
 *
 * Handles queue coalescing, back-pressure, and event-loop yielding for
 * the native desktop geometry streaming path.  These are platform-specific
 * utilities isolated from the main GeometryProcessor.
 */

import type { CoordinateHandler } from './coordinate-handler.js';
import type { MeshData } from './types.js';
import type { GeometryStats as PlatformGeometryStats, GeometryBatch, NativeBatchTelemetry } from './platform-bridge.js';
import type { StreamingGeometryEvent } from './index.js';

// ── Queue tuning constants ──

export const MAX_NATIVE_STREAM_QUEUE_EVENTS = 8;
export const MAX_NATIVE_STREAM_QUEUE_MESHES = 32768;
export const MAX_NATIVE_STREAM_EVENTS_PER_TURN = 4;
export const MAX_NATIVE_STREAM_MESHES_PER_TURN = 8192;
export const MAX_NATIVE_STREAM_DRAIN_MS = 10;

// ── Types ──

export type QueuedNativeStreamingEvent =
  | { type: 'batch'; meshes: MeshData[]; nativeTelemetry?: NativeBatchTelemetry }
  | { type: 'colorUpdate'; updates: Map<number, [number, number, number, number]> };

// ── Helpers ──

export function yieldToEventLoop(): Promise<void> {
  const maybeScheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof maybeScheduler?.yield === 'function') {
    return maybeScheduler.yield();
  }
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

/**
 * Coalesce incoming native events into the queue to reduce per-yield
 * overhead when the JS main thread cannot keep up with Rust production.
 */
export function enqueueNativeStreamingEvent(
  queuedEvents: QueuedNativeStreamingEvent[],
  event: QueuedNativeStreamingEvent,
  queueState: { queuedMeshes: number; coalescedBatchCount: number }
): void {
  if (event.type === 'colorUpdate') {
    const lastEvent = queuedEvents[queuedEvents.length - 1];
    if (lastEvent?.type === 'colorUpdate') {
      for (const [expressId, color] of event.updates) {
        lastEvent.updates.set(expressId, color);
      }
      return;
    }
    queuedEvents.push(event);
    return;
  }

  const lastEvent = queuedEvents[queuedEvents.length - 1];
  const shouldCoalesce =
    lastEvent?.type === 'batch' &&
    (queuedEvents.length >= MAX_NATIVE_STREAM_QUEUE_EVENTS || queueState.queuedMeshes >= MAX_NATIVE_STREAM_QUEUE_MESHES);

  if (shouldCoalesce) {
    for (let i = 0; i < event.meshes.length; i++) {
      lastEvent.meshes.push(event.meshes[i]);
    }
    lastEvent.nativeTelemetry = event.nativeTelemetry;
    queueState.coalescedBatchCount += 1;
  } else {
    queuedEvents.push(event);
  }

  queueState.queuedMeshes += event.meshes.length;
}

/**
 * Shared native streaming generator used by both buffer-based and
 * path-based native geometry streaming.
 *
 * @param startStream  Callback that kicks off the native stream and
 *                     returns a promise resolving when it finishes.
 * @param totalEstimate  Estimated total for the 'start' event.
 * @param coordinator    CoordinateHandler for incremental bounds.
 * @param setLastNativeStats  Callback to persist the latest stats on
 *                            the owning GeometryProcessor instance.
 */
export async function* streamNativeGeometry(
  startStream: (options: {
    onBatch: (batch: GeometryBatch) => void;
    onColorUpdate: (updates: Map<number, [number, number, number, number]>) => void;
    onComplete: (stats: PlatformGeometryStats) => void;
    onError: (error: Error) => void;
  }) => Promise<PlatformGeometryStats>,
  totalEstimate: number,
  coordinator: CoordinateHandler,
  setLastNativeStats: (stats: PlatformGeometryStats) => void,
): AsyncGenerator<StreamingGeometryEvent> {
  coordinator.reset();

  yield { type: 'start', totalEstimate };
  await yieldToEventLoop();
  yield { type: 'model-open', modelID: 0 };

  const queuedEvents: QueuedNativeStreamingEvent[] = [];
  const queueState = { queuedMeshes: 0, coalescedBatchCount: 0 };
  let resolvePending: (() => void) | null = null;
  let completed = false;
  let streamError: Error | null = null;
  let completedTotalMeshes: number | undefined;
  let totalMeshes = 0;

  const wake = () => {
    if (resolvePending) {
      resolvePending();
      resolvePending = null;
    }
  };

  const streamingPromise = startStream({
    onBatch: (batch) => {
      enqueueNativeStreamingEvent(
        queuedEvents,
        { type: 'batch', meshes: batch.meshes, nativeTelemetry: batch.nativeTelemetry },
        queueState
      );
      wake();
    },
    onColorUpdate: (updates) => {
      enqueueNativeStreamingEvent(queuedEvents, { type: 'colorUpdate', updates: new Map(updates) }, queueState);
      wake();
    },
    onComplete: (stats) => {
      setLastNativeStats(stats);
      completedTotalMeshes = stats.totalMeshes;
      completed = true;
      wake();
    },
    onError: (error) => {
      streamError = error;
      completed = true;
      wake();
    },
  });

  while (!completed || queuedEvents.length > 0) {
    let drainedEventCount = 0;
    let drainedMeshCount = 0;
    let drainStartedAt = performance.now();
    while (queuedEvents.length > 0) {
      const event = queuedEvents.shift()!;
      if (event.type === 'colorUpdate') {
        yield { type: 'colorUpdate', updates: event.updates };
        continue;
      }

      queueState.queuedMeshes = Math.max(0, queueState.queuedMeshes - event.meshes.length);
      // Native desktop streaming already produces site-local geometry, so
      // avoid the generic JS RTC/outlier scan on every streamed batch.
      coordinator.processTrustedMeshesIncremental(event.meshes);
      totalMeshes += event.meshes.length;
      const coordinateInfo = coordinator.getCurrentCoordinateInfo();
      yield {
        type: 'batch',
        meshes: event.meshes,
        totalSoFar: totalMeshes,
        coordinateInfo: coordinateInfo || undefined,
        nativeTelemetry: event.nativeTelemetry,
      };
      drainedEventCount += 1;
      drainedMeshCount += event.meshes.length;

      if (queuedEvents.length > 0) {
        const shouldYield =
          drainedEventCount >= MAX_NATIVE_STREAM_EVENTS_PER_TURN ||
          drainedMeshCount >= MAX_NATIVE_STREAM_MESHES_PER_TURN ||
          performance.now() - drainStartedAt >= MAX_NATIVE_STREAM_DRAIN_MS;
        if (shouldYield) {
          await yieldToEventLoop();
          drainedEventCount = 0;
          drainedMeshCount = 0;
          drainStartedAt = performance.now();
        }
      }
    }

    if (streamError) {
      throw streamError;
    }

    if (!completed) {
      await new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
    }
  }

  await streamingPromise;

  if (queueState.coalescedBatchCount > 0) {
    console.info(
      `[GeometryProcessor] Coalesced ${queueState.coalescedBatchCount} native batches while JS drained the queue`
    );
  }

  const coordinateInfo = coordinator.getFinalCoordinateInfo();
  yield { type: 'complete', totalMeshes: completedTotalMeshes ?? totalMeshes, coordinateInfo };
}
