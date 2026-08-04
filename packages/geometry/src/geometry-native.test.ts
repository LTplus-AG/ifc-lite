/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { streamNativeGeometry } from './geometry-native.js';
import { CoordinateHandler } from './coordinate-handler.js';
import type { StreamingGeometryEvent } from './types.js';
import type { GeometryStats } from './platform-bridge.js';

const emptyStats = (): GeometryStats => ({
  totalMeshes: 0,
  totalVertices: 0,
  totalTriangles: 0,
  parseTimeMs: 0,
  geometryTimeMs: 0,
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
