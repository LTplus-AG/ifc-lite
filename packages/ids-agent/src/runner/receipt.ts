/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The run receipt (`06-ai-agent.md` §4): model, prompt version, every
 * request's usage receipt from `@ifc-lite/ai`, every tool call, totals, an
 * optional cost and a digest of exactly what was sent. Like the request
 * receipts it is built from, it holds no prompt, no reply and no
 * credential: the digest lets a privacy view prove which payload a receipt
 * describes without the receipt carrying it.
 */

import type { UsageReceipt } from '@ifc-lite/ai';
import type { AgentMode } from '../prompts/system-v1.js';

export interface ToolCallRecord {
  /** Index of the request whose turn made the call. */
  turn: number;
  name: string;
  ok: boolean;
  /** One line; never document content. */
  summary: string;
  ms: number;
}

/** USD per million tokens, supplied by the host (prices change; the package ships none). */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface RunReceipt {
  runId: string;
  mode: AgentMode;
  model: string;
  promptVersion: string;
  requests: UsageReceipt[];
  toolCalls: ToolCallRecord[];
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    /** False when any request did not report usage: the totals are then a lower bound. */
    usageComplete: boolean;
  };
  /** Present when the host supplied pricing; computed from reported tokens only. */
  costUsd?: number;
  /** SHA-256 (hex) of the canonical JSON of every request payload, in order. */
  payloadDigest: string;
}

export function totalsOf(requests: readonly UsageReceipt[]): RunReceipt['totals'] {
  let inputTokens = 0;
  let outputTokens = 0;
  let usageComplete = true;
  for (const r of requests) {
    if (r.usageReported) {
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
    } else {
      usageComplete = false;
    }
  }
  return { requests: requests.length, inputTokens, outputTokens, usageComplete };
}

export function costOf(totals: RunReceipt['totals'], pricing: ModelPricing): number {
  const usd = (totals.inputTokens * pricing.inputPerMTok + totals.outputTokens * pricing.outputPerMTok) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Hex SHA-256 of a UTF-8 string (Web Crypto: browsers and Node 20+). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
