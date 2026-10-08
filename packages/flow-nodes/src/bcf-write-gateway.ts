/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one path every `bcf.*` write node takes to the server (#6896).
 *
 * A BCF create is not idempotent: a lost response after the server committed
 * leaves a real topic or comment behind, and the node is `volatile`, so a
 * plain rerun would create it again. A host that keeps durable publication
 * state (the viewer) supplies `FlowHost.bcfWrites`: it records the intent
 * before sending, the receipt after, and refuses to resend a write whose
 * earlier attempt has an unknown outcome until someone reconciles it. A host
 * without that state still never retries, and names the unknown outcome
 * instead of reporting a plain failure.
 */

import { BcfApiError, type BcfCommentWriteDto, type BcfTopicWriteDto } from '@ifc-lite/bcf-api';
import { NetworkDeniedError } from '@ifc-lite/sandbox';
import type { Ctx } from './host.js';

/** What a node is about to write, without the bearer token. */
export interface BcfWriteIntent {
  readonly nodeType: string;
  readonly operation: 'createTopic' | 'createComment';
  /** Base URL up to but excluding the version segment, as the node was configured. */
  readonly baseUrl: string;
  readonly version: string;
  readonly projectId: string;
  /** The topic a comment is written to. */
  readonly topicGuid?: string;
  readonly payload: BcfTopicWriteDto | BcfCommentWriteDto;
}

/**
 * Host-owned durable write path. `write` must persist the intent before
 * calling `send`, persist the receipt or failure after, and reject without
 * calling `send` when an identical earlier write is still unresolved.
 */
export interface BcfWriteGateway {
  write<T extends { guid: string }>(intent: BcfWriteIntent, send: () => Promise<T>): Promise<T>;
}

/** Send one write through the host gateway, or directly with explicit unknown-outcome reporting. */
export async function sendBcfWrite<T extends { guid: string }>(
  ctx: Ctx,
  intent: BcfWriteIntent,
  send: () => Promise<T>,
): Promise<T> {
  const gateway = ctx.host.bcfWrites;
  if (gateway) return gateway.write(intent, send);
  try {
    return await send();
  } catch (err) {
    // An HTTP status is a definite answer, and a denied request never left the host.
    if (err instanceof BcfApiError || err instanceof NetworkDeniedError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${intent.nodeType}: outcome unknown — the server may have applied this ${intent.operation} before the connection failed (${reason}). Check the project before running this node again.`,
      { cause: err },
    );
  }
}
