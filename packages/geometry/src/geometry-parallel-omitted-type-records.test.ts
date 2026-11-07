/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * F2 (#8341), parallel host: the prepass worker's `complete` event carries the
 * omitted-type-record count (the only moment it can: the host terminates that
 * worker on `complete`). The host must relay it onto the stream's own
 * `complete`, on both the normal and the zero-jobs exit, and leave the key
 * absent when the worker did not send a valid count.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';
import type { StreamingGeometryEvent } from './index.js';

class FakeWorker {
  postMessage: (message: unknown) => void;
  terminate = vi.fn();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(onPost: (worker: FakeWorker, message: unknown) => void) {
    this.postMessage = vi.fn((message: unknown) => onPost(this, message));
  }
}

let originalWorker: unknown;
beforeEach(() => {
  originalWorker = (globalThis as Record<string, unknown>).Worker;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  vi.restoreAllMocks();
});

/** Worker #0 is the process pool (one worker), worker #1 the prepass worker. */
async function streamComplete(prepassComplete: Record<string, unknown>, withMeta: boolean) {
  let created = 0;
  (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function () {
    const index = created++;
    return new FakeWorker((self, message) => {
      const type = (message as { type?: string }).type;
      if (index === 0 && type === 'stream-end') {
        queueMicrotask(() => self.onmessage?.({ data: { type: 'complete', totalMeshes: 0 } }));
      } else if (index === 1 && type === 'prepass-streaming') {
        queueMicrotask(() => {
          if (withMeta) {
            self.onmessage?.({ data: { type: 'prepass-stream', event: {
              type: 'meta', unitScale: 1, rtcOffset: new Float64Array([0, 0, 0]), needsShift: false,
            } } });
          }
          self.onmessage?.({ data: { type: 'prepass-stream', event: { type: 'complete', totalJobs: 0, ...prepassComplete } } });
        });
      }
    });
  });
  const events: StreamingGeometryEvent[] = [];
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('TIMED_OUT: generator never settled')), 1_000).unref?.();
  });
  const drain = (async () => {
    for await (const event of processParallel(new Uint8Array(16), new CoordinateHandler(), undefined, undefined,
      { workerCountOverride: 1 })) events.push(event);
  })();
  await Promise.race([drain, deadline]);
  const complete = events.find((event) => event.type === 'complete');
  expect(complete).toBeDefined();
  return complete as Extract<StreamingGeometryEvent, { type: 'complete' }>;
}

describe('processParallel relays omitted type records (#8341)', () => {
  it('carries the prepass worker count onto the stream complete', async () => {
    expect((await streamComplete({ omittedTypeRecords: 2 }, true)).omittedTypeRecords).toBe(2);
  });

  it('carries it on the zero-jobs exit too (a file whose only geometry was the omitted type)', async () => {
    expect((await streamComplete({ omittedTypeRecords: 1 }, false)).omittedTypeRecords).toBe(1);
  });

  it('relays a known 0 as 0', async () => {
    expect((await streamComplete({ omittedTypeRecords: 0 }, true)).omittedTypeRecords).toBe(0);
  });

  it('leaves the key absent for an older worker/wasm or a malformed value', async () => {
    for (const extra of [{}, { omittedTypeRecords: -1 }, { omittedTypeRecords: '3' }]) {
      const complete = await streamComplete(extra, true);
      expect('omittedTypeRecords' in complete).toBe(false);
    }
  });
});
