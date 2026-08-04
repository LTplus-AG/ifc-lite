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
import type { GeometryDiagnostics } from './diagnostics.js';

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
 * The two behavioural axes on which the buffer-based native route
 * (`GeometryProcessor.processStreaming`) differs from the path- and
 * cache-based ones. Everything else about the drain loop — including the
 * failure handling this module exists to get right — is shared.
 */
export interface NativeStreamOptions {
  /**
   * Apply native queue back-pressure: coalesce consecutive batch events once
   * the queue is deep, and yield to the event loop mid-drain so the main
   * thread keeps breathing. `processStreaming`'s native branch has always used
   * a plain push-only queue with no mid-drain yield; pass `false` there.
   */
  coalesce?: boolean;
  /**
   * How streamed meshes are folded into the coordinate handler. Defaults to
   * `processTrustedMeshesIncremental` (native output is already site-local, so
   * the generic RTC/outlier scan is skipped). `processStreaming` has always
   * used the generic `processMeshesIncremental`, so it passes that explicitly.
   */
  processMeshes?: (meshes: MeshData[]) => void;
}

/**
 * Shared native streaming generator used by every native geometry route:
 * buffer-based (`processStreaming`), path-based and cache-based.
 *
 * @param startStream  Callback that kicks off the native stream and
 *                     returns a promise resolving when it finishes.
 * @param totalEstimate  Estimated total for the 'start' event.
 * @param coordinator    CoordinateHandler for incremental bounds.
 * @param setLastNativeStats  Callback to persist the latest stats on
 *                            the owning GeometryProcessor instance.
 * @param options  Per-route queue/coordinate behaviour; see NativeStreamOptions.
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
  options: NativeStreamOptions = {},
): AsyncGenerator<StreamingGeometryEvent> {
  const coalesce = options.coalesce !== false;
  const processMeshes =
    options.processMeshes ?? ((meshes: MeshData[]) => coordinator.processTrustedMeshesIncremental(meshes));

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
  let completedDiagnostics: GeometryDiagnostics | undefined;
  let totalMeshes = 0;

  const wake = () => {
    if (resolvePending) {
      resolvePending();
      resolvePending = null;
    }
  };

  const enqueue = (event: QueuedNativeStreamingEvent) => {
    if (coalesce) {
      enqueueNativeStreamingEvent(queuedEvents, event, queueState);
    } else {
      queuedEvents.push(event);
    }
  };

  const streamingPromise = startStream({
    onBatch: (batch) => {
      enqueue({ type: 'batch', meshes: batch.meshes, nativeTelemetry: batch.nativeTelemetry });
      wake();
    },
    onColorUpdate: (updates) => {
      enqueue({ type: 'colorUpdate', updates: new Map(updates) });
      wake();
    },
    onComplete: (stats) => {
      setLastNativeStats(stats);
      completedTotalMeshes = stats.totalMeshes;
      completedDiagnostics = stats.diagnostics;
      completed = true;
      wake();
    },
    onError: (error) => {
      streamError = error;
      completed = true;
      wake();
    },
  });

  // A `startStream` rejection that never reached `onError` used to strand this
  // generator: `completed` stays false, so the drain loop parks on the wake
  // promise below and nothing ever resolves it — the load hangs forever and the
  // failure surfaces only as an unhandled rejection. That is reachable today,
  // because the bridge only routes throws through `onError` from inside its own
  // try/catch: `NativeBridge.processGeometryStreamingPath` has none at all (the
  // missing-cache-key throw, and every failure of the packed-shard stream it
  // delegates to — including the Rust-reported `failed` status and the 60 s
  // stall guard — reject straight out), and its siblings can still reject from
  // the `init()` / `listen()` calls that precede their try. Treat a rejected
  // stream promise as a stream error so the caller sees the real message.
  //
  // Only while the stream is still running, though. A rejection that arrives
  // AFTER `onComplete`/`onError` has settled the stream is teardown fallout,
  // not the load's outcome: `NativeBridge.processGeometryStreaming` runs its
  // three `unlisten()` calls in a `finally`, which executes after `onComplete`,
  // so a throwing `unlisten` rejects the promise of a load that fully
  // succeeded. Failing it here would discard every mesh already delivered.
  // Post-completion rejections are logged by the `finally` below instead.
  void streamingPromise.catch((error: unknown) => {
    if (completed) return;
    // `??=` rather than `=`: `onError` sets `streamError` and `completed`
    // together, so the guard above already covers it, but this keeps the
    // "never shadow a richer onError message" property local to the assignment.
    streamError ??= error instanceof Error ? error : new Error(String(error));
    completed = true;
    wake();
  });

  try {
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
        processMeshes(event.meshes);
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

        if (coalesce && queuedEvents.length > 0) {
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

    // The in-loop check above only runs while the loop still has a reason to
    // spin. `onError` sets `completed` AND leaves the queue empty, so the wake
    // it triggers falls straight out of the loop past that check — and this
    // generator then reported `complete` for a stream that failed. Re-check on
    // the way out so the error reaches the caller.
    if (streamError) {
      throw streamError;
    }
  } finally {
    // Ensure the native stream and its Tauri listeners are torn down
    // deterministically even when this generator is abandoned (.return())
    // while suspended at a `yield` or the pending-wake promise.
    try {
      await streamingPromise;
    } catch (err) {
      // Two ways to land here, neither of which the caller learns anything new
      // from: the rejection arrived while the stream was still running, in which
      // case the handler above already recorded it as `streamError` and the
      // drain loop threw it — this is the same error a second time; or it
      // arrived after the stream had already completed, in which case it is
      // teardown fallout that must NOT retro-fail a finished load. Debug level,
      // because this is the only place that kind is reported at all — a real
      // failure reported through `onError` (rather than only this bare
      // rejection) is not swallowed here: it sets `streamError` unconditionally
      // and the recheck right after this `finally` still throws it below.
      console.debug('[GeometryProcessor] native stream teardown rejected:', err);
    }
  }

  // Defense in depth, matching the shape of the two exit-guard checks above:
  // `onError` is never gated on `completed` — a bridge that reports a genuine
  // failure must win regardless of when that report arrives — so it can still
  // fire after both of those checks already ran clean (streamError was null
  // at both), while this generator sits in the `finally` above awaiting
  // `streamingPromise`. Nothing rechecked `streamError` after that point, so
  // a failure signalled that late was recorded and then never read: the
  // caller got `complete` for a stream that, per its own `onError` call,
  // failed. This does NOT reopen the post-complete teardown case just above —
  // a rejection that only ever reaches the detached `.catch()` (never
  // `onError`) is still gated on `!completed` there and leaves `streamError`
  // null, so that case still falls through to `complete` unchanged.
  if (streamError) {
    throw streamError;
  }

  if (queueState.coalescedBatchCount > 0) {
    console.info(
      `[GeometryProcessor] Coalesced ${queueState.coalescedBatchCount} native batches while JS drained the queue`
    );
  }

  const coordinateInfo = coordinator.getFinalCoordinateInfo();
  yield {
    type: 'complete',
    totalMeshes: completedTotalMeshes ?? totalMeshes,
    coordinateInfo,
    // Native CSG / opening diagnostics (parity with the WASM path's `complete`
    // event). Present only when the native helper reported a non-empty contract.
    ...(completedDiagnostics ? { diagnostics: completedDiagnostics } : {}),
  };
}
