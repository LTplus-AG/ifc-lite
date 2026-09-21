/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared entity-loop chunking for EVERY requirement-kind checker (#5138 PR
 * 3 review, plan §4 item 10 — chunked + cancellable applies to `unique` /
 * `aggregate` / `compare`, not only `element`). One function so the four
 * loops (`rule-engine.ts`'s `runElementRequirement`, `rule-engine-sets.ts`'s
 * `checkUnique`/`checkAggregate`, `rule-engine-compare.ts`'s `checkCompare`)
 * can't drift from one another on chunk size, abort timing or progress
 * shape.
 */

import { throwAbort, yieldToEventLoop } from '../search/filter-evaluate-yield.js';

export const ENTITY_CHUNK_SIZE = 2_000;

export interface RuleEngineProgress {
  ruleIndex: number;
  phase: 'applicability' | 'requirements';
  done: number;
  total: number;
}

/**
 * Call after processing the `done`-th element (1-based). A no-op except at
 * a chunk boundary, where it checks `signal.aborted` (throws `AbortError`
 * via `throwAbort`), reports progress, and yields to the event loop.
 */
export async function maybeYieldChunk(
  done: number,
  total: number,
  ruleIndex: number,
  signal: AbortSignal | undefined,
  onProgress: ((p: RuleEngineProgress) => void) | undefined,
): Promise<void> {
  if (done % ENTITY_CHUNK_SIZE !== 0) return;
  if (signal?.aborted) throwAbort(signal);
  onProgress?.({ ruleIndex, phase: 'requirements', done, total });
  await yieldToEventLoop();
}

/** Final progress tick for the residual (post-loop, since `maybeYieldChunk`
 *  only fires ON a chunk boundary and the last partial chunk never hits
 *  one). */
export function finalProgress(
  total: number,
  ruleIndex: number,
  onProgress: ((p: RuleEngineProgress) => void) | undefined,
): void {
  onProgress?.({ ruleIndex, phase: 'requirements', done: total, total });
}
