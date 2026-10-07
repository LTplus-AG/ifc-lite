/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createWorkerTraceHost } from '@ifc-lite/load-trace';

// #6957: the worker's counter helpers, re-exported so geometry.worker.ts keeps one load-trace import.
export { countCopy, meterTypedArrayArgs } from '@ifc-lite/load-trace';

/**
 * Worker-side load-trace spans (#6956): which geometry-worker requests become
 * a span when the pool enabled tracing (`enableWorkerTrace` in
 * geometry-parallel.ts). Each span is the whole serialised handler, posted back
 * as soon as it settles; untraced loads pass straight through.
 */
export const traceGeometryWorkerMessage = createWorkerTraceHost({
  spanNames: {
    init: 'worker.init',
    'scan-shard': 'shard.scan',
    'prepass-streaming': 'prepass.scan',
    'prepass-streaming-sharded': 'prepass.scan',
    'resolve-styles-shard': 'styles.shard',
    'finalize-styles': 'styles.finalize',
    'stream-chunk': 'geometry.firstChunk',
  },
  // Only the first chunk: one span per slice would cost a message per batch.
  onceTypes: ['stream-chunk'],
  post: (message) => (self as unknown as Worker).postMessage(message),
});

/**
 * Post a pre-pass event. The host terminates the pre-pass worker as soon as it
 * receives the final `complete` event, before this worker's handler returns,
 * so the counters it moved (#6957) are flushed ahead of that one message.
 */
export function postPrepassEvent(event: unknown): void {
  if ((event as { type?: unknown } | null)?.type === 'complete') traceGeometryWorkerMessage.flush();
  (self as unknown as Worker).postMessage({ type: 'prepass-stream', event });
}
