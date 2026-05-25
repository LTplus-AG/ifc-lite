/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dry-run sandbox profile.
 *
 * When the authoring loop wants to execute a candidate bundle against
 * its declared tests, we tighten the runtime budget. The authoring
 * agent is not trusted code; the user has not consented yet; and an
 * accidentally-greedy generated bundle should fail fast rather than
 * burn the user's CPU / memory budget.
 *
 * Defaults follow §02.5: 25% memory of production, 50% CPU of
 * production, deliberate hard cap so we surface "this is too slow" as
 * an authoring failure that drives the repair loop rather than waiting
 * for the test to time out at the production budget.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §7.1.
 */

import type { RuntimeSandboxCreateOptions } from '../host/runtime.js';

export interface DryRunBudget {
  memoryBytes: number;
  timeoutMs: number;
  maxStackBytes: number;
}

/**
 * Production defaults the runtime applies when no override is given.
 * The dry-run profile scales these down (see `DRY_RUN_RATIOS`).
 */
export const PRODUCTION_BUDGET: DryRunBudget = {
  memoryBytes: 64 * 1024 * 1024,
  timeoutMs: 5_000,
  maxStackBytes: 1 * 1024 * 1024,
};

/**
 * Per-axis fraction applied to the production budget. Per spec: 25%
 * memory, 50% CPU. Stack stays full because shallow code with deep
 * recursion is a code smell we want to flag at production budget too.
 */
export const DRY_RUN_RATIOS = {
  memory: 0.25,
  timeout: 0.5,
  maxStack: 1.0,
} as const;

/** Build a dry-run budget derived from the production budget. */
export function buildDryRunBudget(
  base: DryRunBudget = PRODUCTION_BUDGET,
  overrides?: Partial<DryRunBudget>,
): DryRunBudget {
  return {
    memoryBytes: Math.floor((overrides?.memoryBytes ?? base.memoryBytes) * DRY_RUN_RATIOS.memory),
    timeoutMs: Math.floor((overrides?.timeoutMs ?? base.timeoutMs) * DRY_RUN_RATIOS.timeout),
    maxStackBytes: Math.floor((overrides?.maxStackBytes ?? base.maxStackBytes) * DRY_RUN_RATIOS.maxStack),
  };
}

/**
 * Project a dry-run budget into the `limits` shape the sandbox
 * factory accepts. Hosts pass this verbatim when constructing the
 * dry-run runtime.
 */
export function dryRunLimits(
  budget: DryRunBudget = buildDryRunBudget(),
): NonNullable<RuntimeSandboxCreateOptions['limits']> {
  return {
    memoryBytes: budget.memoryBytes,
    timeoutMs: budget.timeoutMs,
    maxStackBytes: budget.maxStackBytes,
  };
}
