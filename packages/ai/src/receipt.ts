/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Usage receipts: one per model request that reached the network. A receipt
 * holds identifiers, times, the outcome and provider-reported token counts.
 * It never holds a prompt, a reply or a credential.
 */

import type { TokenUsage } from './usage.js';

export type RequestOutcomeKind = 'completed' | 'truncated' | 'cancelled' | 'timeout' | 'error';

interface ReceiptBase<Route extends string> {
  id: string;
  model: string;
  /** Which transport carried the request (`proxy`, `anthropic`, a headless host's own name, ...). */
  route: Route;
  /** Epoch ms. */
  startedAt: number;
  finishedAt: number;
  outcome: RequestOutcomeKind;
}

/** Counts appear only when the provider reported them; there is no estimate. */
export type UsageReceipt<Route extends string = string> =
  ReceiptBase<Route> & ({ usageReported: true } & TokenUsage | { usageReported: false });
