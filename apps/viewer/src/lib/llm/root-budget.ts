/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A root budget bounds one task end to end. Every request made on the task's
 * behalf (first attempt, retry, repair follow-up, continuation) reserves from
 * the same object, so no loop can spend more than the root allows.
 *
 * Output tokens are reserved at the request's ceiling and settled afterwards:
 * provider-reported output is charged exactly; unreported output is charged at
 * the full reservation, except a request that streamed nothing, which is
 * charged no output (it still counts as a request).
 */

export interface RootBudgetLimits {
  maxRequests: number;
  maxOutputTokens: number;
}

export interface RootBudget extends RootBudgetLimits {
  requests: number;
  outputTokens: number;
}

export interface BudgetGrant {
  /** The output ceiling this request may use: the lesser of its request and the root's remainder. */
  maxOutputTokens: number;
}

/**
 * Assistant default, one per evidence snapshot. A conversation is capped at
 * ten completed turns (20 messages) by `sendAssistant`, each with a 4,096
 * token ceiling: 40,960 output tokens covers every turn at full length, and
 * 16 requests leaves six for failed attempts and retries before Refresh.
 */
export const ASSISTANT_ROOT_BUDGET: RootBudgetLimits = { maxRequests: 16, maxOutputTokens: 40_960 };

export function createRootBudget(limits: RootBudgetLimits = ASSISTANT_ROOT_BUDGET): RootBudget {
  for (const value of [limits.maxRequests, limits.maxOutputTokens]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Root budget limits must be positive safe integers');
  }
  return { ...limits, requests: 0, outputTokens: 0 };
}

export function remainingBudget(budget: RootBudget): RootBudgetLimits {
  return {
    maxRequests: Math.max(0, budget.maxRequests - budget.requests),
    maxOutputTokens: Math.max(0, budget.maxOutputTokens - budget.outputTokens),
  };
}

/** Reserve one request; null when the root is exhausted. */
export function reserveRequest(budget: RootBudget, requestedOutputTokens: number): BudgetGrant | null {
  const remaining = remainingBudget(budget);
  const maxOutputTokens = Math.min(requestedOutputTokens, remaining.maxOutputTokens);
  if (remaining.maxRequests < 1 || maxOutputTokens < 1) return null;
  budget.requests += 1;
  budget.outputTokens += maxOutputTokens;
  return { maxOutputTokens };
}

/**
 * Settle a grant. `reportedOutputTokens` is the provider's figure, null when
 * none was reported (charged at the reservation), or 0 for a request that
 * produced no output at all.
 */
export function settleRequest(budget: RootBudget, grant: BudgetGrant, reportedOutputTokens: number | null): void {
  if (reportedOutputTokens === null) return;
  const charged = Math.min(reportedOutputTokens, grant.maxOutputTokens);
  budget.outputTokens -= grant.maxOutputTokens - charged;
}
