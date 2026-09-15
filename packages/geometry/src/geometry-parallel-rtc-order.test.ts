/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinateHandler } from './coordinate-handler.js';
import { processParallel } from './geometry-parallel.js';
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
let workers: FakeWorker[];
let callbackErrors: unknown[];

beforeEach(() => {
  originalWorker = (globalThis as Record<string, unknown>).Worker;
  workers = [];
  callbackErrors = [];
});

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  vi.restoreAllMocks();
});

function installPrematureBatch(kind: 'flat' | 'instanced'): void {
  (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function () {
    const index = workers.length;
    const worker = new FakeWorker((self, message) => {
      const posted = message as { type?: string };
      if (index !== 0 || posted.type !== 'init') return;
      queueMicrotask(() => {
        try {
          self.onmessage?.({
            data: kind === 'flat'
              ? {
                  type: 'batch',
                  meshes: [{
                    expressId: 1,
                    positions: new Float32Array([0, 0, 0]),
                    normals: new Float32Array([0, 0, 1]),
                    indices: new Uint32Array([0]),
                    color: [1, 1, 1, 1],
                  }],
                }
              : { type: 'batch', meshes: [], instancedShards: [new ArrayBuffer(8)] },
          });
        } catch (error) {
          callbackErrors.push(error);
        }
      });
    });
    workers.push(worker);
    return worker;
  }) as unknown as typeof Worker;
}

async function drain(kind: 'flat' | 'instanced') {
  installPrematureBatch(kind);
  const events: StreamingGeometryEvent[] = [];
  const generator = processParallel(
    new Uint8Array(16),
    new CoordinateHandler(),
    undefined,
    undefined,
    { workerCountOverride: 1 },
  );
  const consume = (async () => {
    for await (const event of generator) events.push(event);
  })();
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('TIMED_OUT: generator never settled')), 1_000).unref?.();
  });
  await expect(Promise.race([consume, deadline])).rejects.toThrow(
    'batch before the RTC frame was resolved',
  );
  return events;
}

describe('processParallel RTC frame ordering (#4799)', () => {
  it.each(['flat', 'instanced'] as const)(
    'rejects a premature %s batch through the generator and tears workers down',
    async (kind) => {
      const events = await drain(kind);

      expect(callbackErrors).toEqual([]);
      expect(events.some((event) => event.type === 'complete')).toBe(false);
      expect(workers).toHaveLength(2);
      expect(workers.every((worker) => worker.terminate.mock.calls.length > 0)).toBe(true);
    },
  );
});
