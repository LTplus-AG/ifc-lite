/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, vi } from 'vitest';
import { isTraceSpansMessage } from '@ifc-lite/load-trace';
import { postPrepassEvent, traceGeometryWorkerMessage } from './worker-trace.js';

afterEach(() => vi.unstubAllGlobals());

it('sends the scan span before the actual prepass completion event (#6993)', async () => {
  const posted: unknown[] = [];
  vi.stubGlobal('self', { postMessage: (message: unknown) => posted.push(message) });
  await traceGeometryWorkerMessage({ type: 'load-trace:enable', thread: 'prepass' }, async () => {});
  await traceGeometryWorkerMessage({ type: 'prepass-streaming' }, async () => {
    postPrepassEvent({ type: 'progress' });
    expect(posted).toEqual([{ type: 'prepass-stream', event: { type: 'progress' } }]);
    postPrepassEvent({ type: 'complete' });
    // The main thread terminates the worker on this last message. Anything
    // after it is lost, even if this handler eventually reaches its finally.
    expect(posted).toHaveLength(3);
    const spanMessage = posted[1];
    expect(isTraceSpansMessage(spanMessage)).toBe(true);
    if (!isTraceSpansMessage(spanMessage)) throw new Error('Missing completed prepass trace');
    expect(spanMessage.payload.thread).toBe('prepass');
    expect(spanMessage.payload.spans).toHaveLength(1);
    expect(spanMessage.payload.spans[0]).toMatchObject({ name: 'prepass.scan' });
    expect(Number.isFinite(spanMessage.payload.spans[0].end)).toBe(true);
    expect(posted[2]).toEqual({ type: 'prepass-stream', event: { type: 'complete' } });
  });
  expect(posted).toHaveLength(3);
});
