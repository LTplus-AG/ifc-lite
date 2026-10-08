/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A root budget bounds one task end to end. Every request made on the task's
 * behalf (first attempt, retry, repair follow-up, continuation, Flow lane,
 * chunk or resumed run) reserves from the same object, so no loop can spend
 * more than the root allows.
 *
 * Output tokens are reserved at the request's ceiling and settled afterwards:
 * provider-reported output is charged exactly; unreported output is charged at
 * the full reservation, except a request that streamed nothing, which is
 * charged no output (it still counts as a request).
 *
 * A budget is plain data, so it can be persisted with the operation that owns
 * it and restored (`restoreRootBudget`) without resetting what was spent.
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

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function createRootBudget(limits: RootBudgetLimits): RootBudget {
  if (!positive(limits.maxRequests) || !positive(limits.maxOutputTokens)) {
    throw new Error('Root budget limits must be positive safe integers');
  }
  return { maxRequests: limits.maxRequests, maxOutputTokens: limits.maxOutputTokens, requests: 0, outputTokens: 0 };
}

/** A persisted budget, validated; null when the value is not a well-formed budget. */
export function restoreRootBudget(value: unknown): RootBudget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!positive(v.maxRequests) || !positive(v.maxOutputTokens) || !counter(v.requests) || !counter(v.outputTokens)) return null;
  return { maxRequests: v.maxRequests, maxOutputTokens: v.maxOutputTokens, requests: v.requests, outputTokens: v.outputTokens };
}

export function remainingBudget(budget: RootBudget): RootBudgetLimits {
  return {
    maxRequests: Math.max(0, budget.maxRequests - budget.requests),
    maxOutputTokens: Math.max(0, budget.maxOutputTokens - budget.outputTokens),
  };
}

/** Reserve one request; null when the root is exhausted. */
export function reserveRequest(budget: RootBudget, requestedOutputTokens: number): BudgetGrant | null {
  if (!positive(requestedOutputTokens)) return null;
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
