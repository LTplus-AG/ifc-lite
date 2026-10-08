/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Usage receipts: one per model request that reached the network. A receipt
 * holds identifiers, times, the outcome and provider-reported token counts.
 * It never holds a prompt, a reply or a credential.
 */

import type { TokenUsage } from './usage.js';
import type { OutputFormat } from './response-schema.js';

export type RequestOutcomeKind = 'completed' | 'truncated' | 'cancelled' | 'timeout' | 'error';

export interface RequestProvenance {
  contractVersion: 'ifc-lite.ai.request.v1';
  /** Explicitly declared by the producer, never inferred for a generic host. */
  promptVersion?: string;
  /** Actual grant handed to the transport, distinct from provider usage. */
  grantedOutputTokens: number;
  /** Effective parent timer duration (milliseconds). */
  timeoutMs: number;
  finishReason: 'stop' | 'length' | 'max_tokens' | 'end_turn' | 'stop_sequence' | 'tool_calls' | 'function_call' | 'content_filter' | 'refusal' | 'pause_turn' | 'unknown';
  /** Finalized logical system/messages/schema; never a provider wire-byte claim. */
  inputDigest?: { algorithm: 'sha256'; referent: 'logical-input.v1'; value: string };
  inputDigestUnavailable?: 'non-json-input' | 'digest-limit';
  /** Exact completed output text, NOT a native output-artifact digest. */
  outputTextDigest?: { algorithm: 'sha256'; referent: 'output-text.utf8.v1'; value: string };
}

interface ReceiptBase<Route extends string> {
  id: string;
  model: string;
  /** Which transport carried the request (`proxy`, `anthropic`, a headless host's own name, ...). */
  route: Route;
  /** Epoch ms. */
  startedAt: number;
  finishedAt: number;
  outcome: RequestOutcomeKind;
  /** Absent on legacy records and pre-dispatch cancellation outcomes. */
  provenance?: RequestProvenance;
  /** Present for typed requests: the protocol sent, never a live-quality verdict. */
  outputFormat?: OutputFormat;
}

/** Counts appear only when the provider reported them; there is no estimate. */
export type UsageReceipt<Route extends string = string> =
  ReceiptBase<Route> & ({ usageReported: true } & TokenUsage | { usageReported: false });
