/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ClashElement, ClashResult, ClashRule, ClashSettings } from '../types.js';
import { runClash } from './orchestrator.js';
import { TsKernel } from './ts-kernel.js';

export type { ClashKernel, NarrowRecord, RuleDetection } from './kernel.js';
export { runClash } from './orchestrator.js';
export { TsKernel } from './ts-kernel.js';

/** A clash engine: a pure async function of (elements, rules, settings). */
export interface ClashEngine {
  run(elements: ClashElement[], rules: ClashRule[], settings?: ClashSettings): Promise<ClashResult>;
}

/**
 * Reference engine: the shared orchestrator driving the pure-TypeScript geometry
 * kernel (spatial BVH broad phase + exact triangle narrow phase).
 */
export class TsClashEngine implements ClashEngine {
  run(
    elements: ClashElement[],
    rules: ClashRule[],
    settings: ClashSettings = {},
  ): Promise<ClashResult> {
    return runClash(elements, rules, settings, new TsKernel());
  }
}
