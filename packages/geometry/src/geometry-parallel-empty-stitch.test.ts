/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PostHog 2026-10-28: a 27 MB model failed deterministically (first attempt
 * and lowest-tier retry) with "Geometry worker error: finalizePrepassStyles:
 * no entity index". When the sharded scan stitches ZERO entities, delivering
 * that index installs none on the workers (an empty index is stored as none),
 * so the sharded-only `finalize-styles` step always throws. The empty stitch
 * must take the serial pre-pass fallback, exactly like a stitch miss.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';
import type { StreamingGeometryEvent } from './index.js';

interface Message { type: string; [key: string]: unknown }

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminate = vi.fn();
  received: Message[] = [];
  constructor(private handle: (worker: FakeWorker, message: Message) => void) {}
  postMessage(message: Message) {
    this.received.push(message);
    this.handle(this, message);
  }
  reply(data: unknown) { this.onmessage?.({ data }); }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sharded pre-pass with an empty stitch', () => {
  it('falls back to the serial pre-pass instead of finalizing styles without an index', async () => {
    const created: FakeWorker[] = [];
    vi.stubGlobal('Worker', vi.fn().mockImplementation(function () {
      const worker = new FakeWorker((self, message) => {
        const emit = (event: Record<string, unknown>) => self.reply({ type: 'prepass-stream', event });
        if (message.type === 'scan-shard') {
          const i = message.shardIndex as number;
          queueMicrotask(() => self.reply({
            type: 'shard-result', shardIndex: i,
            ids: new Uint32Array(), starts: new Uint32Array(),
            lengths: new Uint32Array(), classes: new Uint8Array(), handoff: i === 0 ? 0 : -1,
          }));
        } else if (message.type === 'prepass-streaming') {
          queueMicrotask(() => emit({ type: 'complete', totalJobs: 0 }));
        } else if (message.type === 'stream-end') {
          self.reply({ type: 'complete', totalMeshes: 0 });
        }
      });
      created.push(worker);
      return worker;
    }));

    const shared = new SharedArrayBuffer(27 * 1024 * 1024);
    const events: StreamingGeometryEvent[] = [];
    let failure: unknown;
    const drain = (async () => {
      try {
        for await (const event of processParallel(new Uint8Array(shared), new CoordinateHandler(), undefined, shared,
          { workerCountOverride: 2 })) events.push(event);
      } catch (err) {
        failure = err;
      }
    })();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await drain;

    const sent = created.flatMap((w) => w.received.map((m) => m.type));
    expect(sent).toContain('scan-shard');
    expect(sent).toContain('prepass-streaming');
    expect(sent).not.toContain('prepass-streaming-sharded');
    expect(sent).not.toContain('finalize-styles');
    expect(sent).not.toContain('set-entity-index');
    expect(failure).toBeUndefined();
    expect(events.some((event) => event.type === 'complete')).toBe(true);
  });
});
