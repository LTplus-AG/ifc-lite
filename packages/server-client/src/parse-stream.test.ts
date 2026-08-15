/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IfcServerClient } from './client.js';
import type { StreamEvent } from './types.js';

/** Build a Response whose body streams `chunks` as SSE text. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function stubFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

function client(): IfcServerClient {
  return new IfcServerClient({ baseUrl: 'https://example.invalid' });
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseStream', () => {
  it('yields every event of a well-formed stream', async () => {
    stubFetch(
      sseResponse([
        frame({ type: 'start', total_estimate: 2 }),
        frame({ type: 'progress', processed: 1, total: 2 }),
        frame({
          type: 'complete',
          stats: { total_time_ms: 1 },
          metadata: {},
        }),
      ]),
    );

    const events = await drain(client().parseStream(new ArrayBuffer(4)));
    expect(events.map((e) => e.type)).toEqual(['start', 'progress', 'complete']);
  });

  it('throws when the stream ends before a terminal event', async () => {
    // Server died after the first progress event: the transport closed
    // cleanly, so `reader.read()` reports done and nothing else signals
    // that the parse never finished.
    stubFetch(
      sseResponse([
        frame({ type: 'start', total_estimate: 2 }),
        frame({ type: 'progress', processed: 1, total: 2 }),
      ]),
    );

    const events: StreamEvent[] = [];
    await expect(async () => {
      for await (const ev of client().parseStream(new ArrayBuffer(4))) {
        events.push(ev);
      }
    }).rejects.toThrow(/ended without/i);
    // The events that did arrive were still delivered before the throw.
    expect(events.map((e) => e.type)).toEqual(['start', 'progress']);
  });

  it('throws when the final frame is truncated mid-JSON', async () => {
    stubFetch(
      sseResponse([
        frame({ type: 'start', total_estimate: 2 }),
        'data: {"type":"complete","stats":{"total_ti',
      ]),
    );

    await expect(
      drain(client().parseStream(new ArrayBuffer(4))),
    ).rejects.toThrow(/ended without/i);
  });

  it('surfaces a terminal error event without throwing', async () => {
    // `error` is a documented event type callers switch on; reaching it
    // means the server reported the failure, so the stream is complete.
    stubFetch(
      sseResponse([
        frame({ type: 'start', total_estimate: 2 }),
        frame({ type: 'error', message: 'boom', code: 'E_BOOM' }),
      ]),
    );

    const events = await drain(client().parseStream(new ArrayBuffer(4)));
    expect(events.map((e) => e.type)).toEqual(['start', 'error']);
  });

  it('surfaces a terminal error event that arrives in the tail buffer without a trailing delimiter', async () => {
    // Same as the previous test, except the final `error` frame has no
    // trailing "\n\n" -- e.g. the connection closes right after the server
    // writes the frame body. `reader.read()` then reports `done` with the
    // frame still sitting in `buffer` (never split off by `split('\n\n')`),
    // so it is only ever seen by the tail-buffer decode path, not the
    // main-loop path. This exercises the `:978` terminal check
    // (`tail.type === 'complete' || tail.type === 'error'`) specifically.
    stubFetch(
      sseResponse([
        frame({ type: 'start', total_estimate: 2 }),
        // no trailing '\n\n' after this frame
        `data: ${JSON.stringify({ type: 'error', message: 'boom', code: 'E_BOOM' })}`,
      ]),
    );

    const events = await drain(client().parseStream(new ArrayBuffer(4)));
    expect(events.map((e) => e.type)).toEqual(['start', 'error']);
  });

  it('does not throw when the consumer breaks out early', async () => {
    stubFetch(
      sseResponse([
        frame({ type: 'start', total_estimate: 2 }),
        frame({ type: 'progress', processed: 1, total: 2 }),
      ]),
    );

    const seen: StreamEvent[] = [];
    for await (const ev of client().parseStream(new ArrayBuffer(4))) {
      seen.push(ev);
      break;
    }
    expect(seen.map((e) => e.type)).toEqual(['start']);
  });

  it('propagates an error thrown by the consumer instead of swallowing it', async () => {
    stubFetch(
      sseResponse([
        frame({ type: 'start', total_estimate: 2 }),
        frame({
          type: 'complete',
          stats: { total_time_ms: 1 },
          metadata: {},
        }),
      ]),
    );

    const gen = client().parseStream(new ArrayBuffer(4));
    await gen.next();
    await expect(gen.throw(new Error('consumer blew up'))).rejects.toThrow(
      'consumer blew up',
    );
  });

  it('warns about a malformed mid-stream frame instead of dropping it silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(
      sseResponse([
        'data: {not json}\n\n',
        frame({
          type: 'complete',
          stats: { total_time_ms: 1 },
          metadata: {},
        }),
      ]),
    );

    const events = await drain(client().parseStream(new ArrayBuffer(4)));
    expect(events.map((e) => e.type)).toEqual(['complete']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
