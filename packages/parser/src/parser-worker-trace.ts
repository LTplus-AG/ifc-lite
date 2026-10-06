/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createWorkerPhaseTrace, type TraceAttrs, type WorkerPhaseTrace } from '@ifc-lite/load-trace';

/**
 * Parser-worker load-trace spans (#6979). `WorkerParser` enables them with
 * `enableWorkerTrace` when the caller's load is traced and merges what comes
 * back under its `parser.worker` span. The parse is one long handler and the
 * host terminates the worker on `complete` / `error`, so `parser.worker.ts`
 * flushes before posting either (and after `partial-store`).
 *
 * Spans: `parser.parse` (whole handler), `parser.entityIndexWait`,
 * `parser.wasmInit`, one `columnar.<phase>` per `parseColumnar` progress
 * phase, `parser.spatialReady.serialize` and `parser.transport.serialize`.
 */
export function createParserWorkerTrace(): WorkerPhaseTrace {
  return createWorkerPhaseTrace({ post: (message) => (self as unknown as Worker).postMessage(message) });
}

/** `parseColumnar` progress phase -> span name (`building entities` -> `columnar.building-entities`); `complete` ends the last one. */
export function columnarPhaseSpan(phase: string): string | null {
  return phase === 'complete' ? null : `columnar.${phase.trim().replace(/\s+/g, '-')}`;
}

/** Close the last phase and the `parser.parse` span, then post them: call BEFORE `complete` / `error`, which the host answers with `terminate()`. */
export function finishParseTrace(trace: WorkerPhaseTrace, parseSpan: number, attrs: TraceAttrs): void {
  trace.step(null);
  trace.end(parseSpan, attrs);
  trace.flush();
}
