/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where work that runs OUTSIDE the loader finds its load's trace (#6979).
 * `useIfcLoader` owns each load's `LoadTrace`, but the streaming upload, the
 * post-stream finalize and camera fit (useGeometryStreaming), the placed BVH
 * build and the tier-1 search index all run from effects and timers that never
 * see it. The loader publishes the trace here when the load starts.
 *
 * With tracing off nothing is ever published, so every lookup returns
 * `NOOP_LOAD_TRACE` and every call site stays a no-op.
 */

import { NOOP_LOAD_TRACE, type LoadTrace } from '@ifc-lite/load-trace';

/** Loads retained per model id; matches the tracer's own retention. */
const MAX_MODELS = 16;
const byModel = new Map<string, LoadTrace>();
const taken = new WeakMap<LoadTrace, Set<string>>();
let latest: LoadTrace = NOOP_LOAD_TRACE;

/** Called by the loader as a load starts: the newest load owns the streaming work from here on. */
export function publishLoadTrace(modelId: string, trace: LoadTrace): void {
  if (!trace.enabled) return;
  byModel.delete(modelId);
  byModel.set(modelId, trace);
  if (byModel.size > MAX_MODELS) byModel.delete(byModel.keys().next().value as string);
  latest = trace;
}

/** The newest load's trace: the one streaming uploads and the post-stream finalize belong to. */
export function activeLoadTrace(): LoadTrace {
  return latest;
}

/** The trace of `modelId`'s most recent load (no-op when there is none). */
export function modelLoadTrace(modelId: string): LoadTrace {
  return byModel.get(modelId) ?? NOOP_LOAD_TRACE;
}

/**
 * `trace` the FIRST time `phase` asks for it, a no-op after. A post-load phase
 * (camera fit, finalize, BVH build, search index) is recorded once per load,
 * not on every later rebuild a model move or visibility toggle triggers.
 */
export function tracePhaseOnce(trace: LoadTrace, phase: string): LoadTrace {
  if (!trace.enabled) return NOOP_LOAD_TRACE;
  let seen = taken.get(trace);
  if (!seen) taken.set(trace, (seen = new Set()));
  if (seen.has(phase)) return NOOP_LOAD_TRACE;
  seen.add(phase);
  return trace;
}
