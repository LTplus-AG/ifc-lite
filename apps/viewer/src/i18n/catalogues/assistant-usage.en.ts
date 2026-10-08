/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Assistant request accounting: per-answer usage receipts, the free-tier
 * request quota in the composer footer and the root-budget refusal
 * (`AssistantUsage.tsx`, `AssistantPanel.tsx`).
 */
export const assistantUsageEn = {
  'assistantUsage.receiptTokens': '{input} → {output} tokens · {seconds} s',
  'assistantUsage.receiptUnreported': 'Usage not reported · {seconds} s',
  'assistantUsage.freeRemaining': 'Free requests left: {remaining} of {limit}',
  'assistantUsage.freeChecking': 'Free requests left: checking…',
  'assistantUsage.freeUnknown': 'Free requests left: unknown',
  'assistantUsage.budgetExhausted': 'This conversation has used its request budget. Refresh evidence to start a new conversation.',
} as const satisfies Record<string, TranslationValue>;
