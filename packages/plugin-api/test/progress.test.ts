/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `readWithProgress` is the one body reader every shipped provider streams
 * downloads through (#6375), so its contract is the host's: progress never
 * goes backwards, ends at the returned buffer's byte length, and is
 * throttled to about 10 Hz however small the chunks are.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWithProgress } from '../src/index.js';

type Call = readonly [received: number, total: number | undefined];

/** A response whose body yields `chunks` one by one, advancing fake time by
 * `msPerChunk` before each, the way a slow network hands bytes over. */
function streamedResponse(chunks: readonly Uint8Array[], headers: Record<string, string> = {}, msPerChunk = 0): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (msPerChunk > 0) vi.advanceTimersByTime(msPerChunk);
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

function bytes(length: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i + seed) % 251);
}

function record(): { calls: Call[]; onProgress: (received: number, total?: number) => void } {
  const calls: Call[] = [];
  return { calls, onProgress: (received, total) => calls.push([received, total]) };
}

function expectMonotonicEndingAt(calls: readonly Call[], byteLength: number): void {
  expect(calls.length).toBeGreaterThan(0);
  for (let i = 1; i < calls.length; i++) {
    expect(calls[i][0], `call ${i} went backwards`).toBeGreaterThanOrEqual(calls[i - 1][0]);
  }
  expect(calls.at(-1)).toEqual([byteLength, byteLength]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('readWithProgress', () => {
  it('returns the exact bytes, reassembled across chunks', async () => {
    const parts = [bytes(3, 0), bytes(5, 3), bytes(2, 8)];
    const { calls, onProgress } = record();
    const buffer = await readWithProgress(streamedResponse(parts), onProgress);
    expect(new Uint8Array(buffer)).toEqual(bytes(10));
    expectMonotonicEndingAt(calls, 10);
  });

  it('reports (0, total) before the first byte, with Content-Length as the total', async () => {
    const { calls, onProgress } = record();
    await readWithProgress(streamedResponse([bytes(4)], { 'Content-Length': '4' }), onProgress, 999);
    expect(calls[0]).toEqual([0, 4]);
  });

  it('falls back to the listing size when Content-Length is absent', async () => {
    const { calls, onProgress } = record();
    await readWithProgress(streamedResponse([bytes(4)]), onProgress, 4);
    expect(calls[0]).toEqual([0, 4]);
  });

  it('reports no total when neither Content-Length nor a fallback is known', async () => {
    const { calls, onProgress } = record();
    await readWithProgress(streamedResponse([bytes(4)]), onProgress);
    expect(calls[0]).toEqual([0, undefined]);
    expect(calls.at(-1)).toEqual([4, 4]);
  });

  it('ignores Content-Length on a content-encoded response (it counts wire bytes, not decoded ones)', async () => {
    const { calls, onProgress } = record();
    await readWithProgress(
      streamedResponse([bytes(40)], { 'Content-Length': '12', 'Content-Encoding': 'gzip' }),
      onProgress,
      40,
    );
    expect(calls[0]).toEqual([0, 40]);
  });

  it('drops a total the stream outgrows instead of reporting received > total', async () => {
    vi.useFakeTimers();
    const { calls, onProgress } = record();
    await readWithProgress(streamedResponse([bytes(5), bytes(5), bytes(5)], {}, 150), onProgress, 6);
    for (const [received, total] of calls) {
      if (total !== undefined) expect(received).toBeLessThanOrEqual(total);
    }
    expectMonotonicEndingAt(calls, 15);
  });

  it('throttles intermediate reports to about 10 Hz', async () => {
    vi.useFakeTimers();
    // 100 chunks 10 ms apart: one second of transfer.
    const parts = Array.from({ length: 100 }, (_, i) => bytes(10, i));
    const { calls, onProgress } = record();
    await readWithProgress(streamedResponse(parts, { 'Content-Length': '1000' }, 10), onProgress);
    // Start + ~10 throttled + final; unthrottled would be 102.
    expect(calls.length).toBeGreaterThanOrEqual(10);
    expect(calls.length).toBeLessThanOrEqual(13);
    expectMonotonicEndingAt(calls, 1000);
  });

  it('is plain arrayBuffer() when no callback is given', async () => {
    const buffer = await readWithProgress(streamedResponse([bytes(3)]), undefined);
    expect(buffer.byteLength).toBe(3);
  });

  it('handles a null-body response', async () => {
    const { calls, onProgress } = record();
    const buffer = await readWithProgress(new Response(null, { status: 200 }), onProgress);
    expect(buffer.byteLength).toBe(0);
    expect(calls).toEqual([
      [0, undefined],
      [0, 0],
    ]);
  });

  it('rejects when the stream errors mid-transfer', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes(2));
        } else {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        }
      },
    });
    const { onProgress } = record();
    await expect(readWithProgress(new Response(body), onProgress)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
