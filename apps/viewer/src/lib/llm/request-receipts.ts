/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Usage receipts: one per model request, kept in memory for the session.
 * A receipt holds identifiers, times, the outcome and provider-reported token
 * counts. It never holds a prompt, a reply or a credential, and it is never
 * persisted.
 */

import { create } from 'zustand';
import type { StreamRoute } from './byok-guard.js';
import type { TokenUsage } from './token-usage.js';

export type RequestOutcomeKind = 'completed' | 'truncated' | 'cancelled' | 'timeout' | 'error';

interface ReceiptBase {
  id: string;
  model: string;
  route: Exclude<StreamRoute['kind'], 'missing-key'>;
  /** Epoch ms. */
  startedAt: number;
  finishedAt: number;
  outcome: RequestOutcomeKind;
}

/** Counts appear only when the provider reported them; there is no estimate. */
export type UsageReceipt = ReceiptBase & ({ usageReported: true } & TokenUsage | { usageReported: false });

/** Enough for a session's recent history without growing unbounded. */
export const RECEIPT_LIMIT = 50;

export const useRequestReceipts = create<{ receipts: UsageReceipt[] }>(() => ({ receipts: [] }));

export function recordReceipt(receipt: UsageReceipt): void {
  useRequestReceipts.setState(state => ({ receipts: [...state.receipts, receipt].slice(-RECEIPT_LIMIT) }));
}
