/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { streamNativeGeometry } from './geometry-native.js';
import { CoordinateHandler } from './coordinate-handler.js';
import type { MeshData, StreamingGeometryEvent } from './types.js';
import type { GeometryBatch, GeometryStats } from './platform-bridge.js';

const emptyStats = (): GeometryStats => ({
  totalMeshes: 0,
  totalVertices: 0,
  totalTriangles: 0,
  parseTimeMs: 0,
  geometryTimeMs: 0,
});

const mesh = (expressId: number): MeshData => ({
  expressId,
  ifcType: 'IfcWall',
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  color: [1, 0, 0, 1],
});

const batch = (expressId: number): GeometryBatch => ({
  meshes: [mesh(expressId)],
  progress: { processed: expressId, total: 2, currentType: 'IfcWall' },
});

/** Stats a bridge reports for a load that produced two meshes. */
const twoMeshStats = (): GeometryStats => ({
  ...emptyStats(),
  totalMeshes: 2,
  totalVertices: 6,
  totalTriangles: 2,
});

/**
 * Drain the generator, failing fast instead of hanging.
 *
 * Before the rejection guard in `streamNativeGeometry`, a `startStream` promise
 * that rejected WITHOUT calling `onError` left the drain loop parked forever on
 * a wake promise nothing resolved — so the failure mode under test is a HANG,
 * and a bare `await` would stall the suite rather than fail it.
 */
async function drainWithDeadline(
  gen: AsyncGenerator<StreamingGeometryEvent>,
  ms = 1_000,
): Promise<StreamingGeometryEvent[]> {
  const events: StreamingGeometryEvent[] = [];
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('TIMED_OUT: generator never settled')), ms).unref?.();
  });
  const drain = (async () => {
    for await (const event of gen) events.push(event);
    return events;
  })();
  await Promise.race([drain, deadline]);
  return events;
}

describe('streamNativeGeometry when the bridge rejects without calling onError', () => {
  // Not hypothetical: `NativeBridge.processGeometryStreamingPath` has no
  // try/catch at all (its missing-cache-key throw and every failure of the
  // packed-shard stream reject straight out), and the siblings that do have one
  // can still reject from the `init()` / `listen()` calls that precede it.
  it('surfaces the rejection instead of hanging', async () => {
    const gen = streamNativeGeometry(
      () => Promise.reject(new Error('Packed shard path streaming requires a cache key')),
      0,
      new CoordinateHandler(),
      () => {},
    );

    await expect(drainWithDeadline(gen)).rejects.toThrow(
      'Packed shard path streaming requires a cache key',
    );
  });

  it('normalises a non-Error rejection', async () => {
    const gen = streamNativeGeometry(
      () => Promise.reject('native stream died'),
      0,
      new CoordinateHandler(),
      () => {},
    );

    await expect(drainWithDeadline(gen)).rejects.toThrow('native stream died');
  });

  it('keeps the onError message when the bridge reports it the normal way', async () => {
    // The guard must not shadow a richer `onError` message with the rejection
    // reason: bridges that route through `onError` call it BEFORE rethrowing.
    const gen = streamNativeGeometry(
      (options) => {
        options.onError(new Error('rich onError message'));
        return Promise.reject(new Error('bare rethrow'));
      },
      0,
      new CoordinateHandler(),
      () => {},
    );

    await expect(drainWithDeadline(gen)).rejects.toThrow('rich onError message');
  });
});

describe('streamNativeGeometry when the bridge reports onError', () => {
  it('throws rather than reporting `complete` for a stream that failed', async () => {
    // The in-loop `if (streamError) throw` only runs while the loop still has a
    // reason to spin. `onError` sets `completed` and leaves the queue empty, so
    // the wake it triggers exits the loop past that check — this generator used
    // to swallow the error and yield `complete` with the meshes seen so far.
    const gen = streamNativeGeometry(
      (options) =>
        new Promise((resolve) => {
          setTimeout(() => {
            options.onError(new Error('native geometry stream failed mid-load'));
            resolve(emptyStats());
          }, 0).unref?.();
        }),
      0,
      new CoordinateHandler(),
      () => {},
    );

    await expect(drainWithDeadline(gen)).rejects.toThrow('native geometry stream failed mid-load');
  });

  it('still throws when the bridge rejects after batches but before completing', async () => {
    // Negative case for the post-complete guard below: batches already yielded
    // must NOT make a genuine mid-stream failure look like a finished load.
    const gen = streamNativeGeometry(
      (options) => {
        options.onBatch(batch(1));
        options.onBatch(batch(2));
        return Promise.reject(new Error('native stream died mid-load'));
      },
      0,
      new CoordinateHandler(),
      () => {},
    );

    await expect(drainWithDeadline(gen)).rejects.toThrow('native stream died mid-load');
  });

  it('still completes normally when the stream succeeds', async () => {
    const gen = streamNativeGeometry(
      (options) => {
        options.onComplete(emptyStats());
        return Promise.resolve(emptyStats());
      },
      0,
      new CoordinateHandler(),
      () => {},
    );

    const events = await drainWithDeadline(gen);
    expect(events.map((e) => e.type)).toEqual(['start', 'model-open', 'complete']);
  });
});

describe('streamNativeGeometry when the stream rejects AFTER completing', () => {
  // `NativeBridge.processGeometryStreaming` runs its three `unlisten()` calls in
  // a `finally`, i.e. AFTER `onComplete` has already reported full stats. If any
  // of them throws, the bridge promise rejects for a load that fully succeeded.
  // Retro-failing that load — discarding every mesh already delivered — is worse
  // than losing the teardown error, which is still logged.
  const teardownFailure = () => new Error('post-complete teardown failure');

  const startStream =
    (rejectAfterMs: number | 'microtask') =>
    (options: {
      onBatch: (b: GeometryBatch) => void;
      onComplete: (s: GeometryStats) => void;
    }): Promise<GeometryStats> => {
      options.onBatch(batch(1));
      options.onBatch(batch(2));
      options.onComplete(twoMeshStats());
      if (rejectAfterMs === 'microtask') {
        return Promise.reject(teardownFailure());
      }
      return new Promise<GeometryStats>((_, reject) => {
        setTimeout(() => reject(teardownFailure()), rejectAfterMs).unref?.();
      });
    };

  it('still delivers `complete` when the rejection lands on the microtask queue', async () => {
    const gen = streamNativeGeometry(
      startStream('microtask'),
      0,
      new CoordinateHandler(),
      () => {},
    );

    const events = await drainWithDeadline(gen);
    expect(events.map((e) => e.type)).toEqual(['start', 'model-open', 'batch', 'batch', 'complete']);
    expect(events.at(-1)).toMatchObject({ type: 'complete', totalMeshes: 2 });
  });

  it('still delivers `complete` when the rejection lands a macrotask later', async () => {
    // Same failure, different timing. Before the `!completed` gate these two
    // diverged: the microtask one destroyed the load, the 10 ms one was demoted
    // to a debug log — the same bridge fault with two different outcomes.
    const gen = streamNativeGeometry(startStream(10), 0, new CoordinateHandler(), () => {});

    const events = await drainWithDeadline(gen);
    expect(events.map((e) => e.type)).toEqual(['start', 'model-open', 'batch', 'batch', 'complete']);
    expect(events.at(-1)).toMatchObject({ type: 'complete', totalMeshes: 2 });
  });

  it('keeps the onError failure when the rejection follows it', async () => {
    // `onError` also sets `completed`, so the gate must not turn a reported
    // failure into a success just because the rejection arrived second.
    const gen = streamNativeGeometry(
      (options) => {
        options.onBatch(batch(1));
        options.onError(new Error('native geometry stream failed'));
        return Promise.reject(teardownFailure());
      },
      0,
      new CoordinateHandler(),
      () => {},
    );

    await expect(drainWithDeadline(gen)).rejects.toThrow('native geometry stream failed');
  });

  it('still completes when the bridge only ever calls onComplete before rejecting', async () => {
    // The literal shape `NativeBridge.processGeometryStreaming` produces when
    // `unlisten()` throws: `onComplete` already ran with full stats, `onError`
    // is never called (that path only wraps the code *before* `onComplete`),
    // and the promise rejects once teardown gets a turn. Pinned explicitly so
    // the next test — which adds a late `onError` to the same shape — can't be
    // read as proof this one changed too.
    const gen = streamNativeGeometry(startStream(5), 0, new CoordinateHandler(), () => {});

    const events = await drainWithDeadline(gen);
    expect(events.map((e) => e.type)).toEqual(['start', 'model-open', 'batch', 'batch', 'complete']);
  });

  it('surfaces a genuine failure reported by a late `onError`, even after completing', async () => {
    // `onError` is never gated on `completed` — a failure it reports must win
    // regardless of when it arrives. Here it arrives late: after `onComplete`
    // has already emptied the queue and both in-loop/post-loop exit checks
    // have already run clean (`streamError` was still null at both), and only
    // fires once this generator is inside the `finally` above, awaiting the
    // same `streamingPromise`. Before the recheck added after that `finally`,
    // nothing looked at `streamError` again, so this `onError` was recorded
    // and then never read — the caller got `complete` for a stream that, per
    // its own `onError` call, failed.
    const gen = streamNativeGeometry(
      (options) => {
        options.onBatch(batch(1));
        options.onBatch(batch(2));
        options.onComplete(twoMeshStats());
        return new Promise<GeometryStats>((_, reject) => {
          setTimeout(() => {
            options.onError(new Error('late genuine stream failure'));
            reject(teardownFailure());
          }, 5).unref?.();
        });
      },
      0,
      new CoordinateHandler(),
      () => {},
    );

    await expect(drainWithDeadline(gen)).rejects.toThrow('late genuine stream failure');
  });
});
