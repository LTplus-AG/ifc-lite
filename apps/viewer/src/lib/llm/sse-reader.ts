/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export function drainSseBuffer(buffer: string, flush: boolean = false): { events: string[]; remainder: string } {
  buffer = flush ? buffer.replace(/\r\n?/g, '\n') : buffer.replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n');
  if (flush) {
    const trimmed = buffer.trim();
    return {
      events: trimmed ? trimmed.split('\n\n').filter(Boolean) : [],
      remainder: '',
    };
  }
  const parts = buffer.split('\n\n');
  return {
    events: parts.slice(0, -1).filter(Boolean),
    remainder: parts.at(-1) ?? '',
  };
}

/**
 * Read an SSE stream, invoking onEvent for each `data:` payload.
 * Skips `[DONE]` sentinels and malformed lines. Returns true if the stream
 * completed normally; false on abort or error (errors are forwarded via
 * onError, aborts are silent).
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onEvent: (data: string) => void,
  onError: (err: Error) => void,
): Promise<boolean> {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel(signal?.reason).catch(error => console.debug('[sse] cancellation failed', error)); };
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatchDrained = (events: string[]) => {
    for (const evt of events) {
      const fields = evt.split('\n').filter(line => line.startsWith('data:')).map(line => {
        const value = line.slice(5);
        return value.startsWith(' ') ? value.slice(1) : value;
      });
      const data = fields.join('\n');
      if (!fields.length || data === '[DONE]') continue;
      try {
        onEvent(data);
      } catch (err) {
        console.debug('[sse] skipped event', err);
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return false;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const drained = drainSseBuffer(buffer);
      buffer = drained.remainder;
      dispatchDrained(drained.events);
    }
    buffer += decoder.decode();
    dispatchDrained(drainSseBuffer(buffer, true).events);
    return true;
  } catch (err) {
    if (signal?.aborted) return false;
    onError(err instanceof Error ? err : new Error(String(err)));
    return false;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

