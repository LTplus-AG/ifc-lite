/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_BUDGET,
  DRY_RUN_RATIOS,
  buildDryRunBudget,
  dryRunLimits,
} from './profile.js';

describe('dryrun/profile', () => {
  it('halves the timeout and quarters the memory by default', () => {
    const budget = buildDryRunBudget();
    expect(budget.memoryBytes).toBe(Math.floor(PRODUCTION_BUDGET.memoryBytes * 0.25));
    expect(budget.timeoutMs).toBe(Math.floor(PRODUCTION_BUDGET.timeoutMs * 0.5));
    expect(budget.maxStackBytes).toBe(PRODUCTION_BUDGET.maxStackBytes);
  });

  it('applies overrides BEFORE scaling so callers can ratchet down further', () => {
    const budget = buildDryRunBudget(PRODUCTION_BUDGET, { memoryBytes: 1024 });
    expect(budget.memoryBytes).toBe(Math.floor(1024 * DRY_RUN_RATIOS.memory));
  });

  it('projects into the limits shape the sandbox factory expects', () => {
    const limits = dryRunLimits();
    expect(limits.memoryBytes).toBeGreaterThan(0);
    expect(limits.timeoutMs).toBeGreaterThan(0);
    expect(limits.maxStackBytes).toBeGreaterThan(0);
  });

  it('ratios are explicitly the documented spec values', () => {
    expect(DRY_RUN_RATIOS.memory).toBe(0.25);
    expect(DRY_RUN_RATIOS.timeout).toBe(0.5);
  });
});
