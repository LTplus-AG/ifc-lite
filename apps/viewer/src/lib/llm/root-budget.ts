/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Assistant's root budget. Accounting (reserve, settle, remaining) is the
 * shared `@ifc-lite/ai` core, the same one Flow AI nodes and headless hosts
 * spend from; this module only owns the Assistant's default limits.
 */

import { createRootBudget as createSharedRootBudget, type RootBudget, type RootBudgetLimits } from '@ifc-lite/ai';

/**
 * Assistant default, one per evidence snapshot. A conversation is capped at
 * ten completed turns (20 messages) by `sendAssistant`, each with a 4,096
 * token ceiling: 40,960 output tokens covers every turn at full length, and
 * 16 requests leaves six for failed attempts and retries before Refresh.
 */
export const ASSISTANT_ROOT_BUDGET: RootBudgetLimits = { maxRequests: 16, maxOutputTokens: 40_960 };

export function createRootBudget(limits: RootBudgetLimits = ASSISTANT_ROOT_BUDGET): RootBudget {
  return createSharedRootBudget(limits);
}
