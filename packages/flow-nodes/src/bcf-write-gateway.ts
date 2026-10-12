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

import type { BcfCommentWriteDto, BcfTopicWriteDto } from '@ifc-lite/bcf-api';
import { NetworkDeniedError } from '@ifc-lite/sandbox';
import { classifyWriteError } from './bcf-publication.js';
import type { Ctx } from './host.js';
import { redactDeep, redactText } from './secrets.js';

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
  write<T extends { guid: string }>(intent: BcfWriteIntent, send: () => Promise<T>, secrets?: readonly string[]): Promise<T>;
}

/** Send one write through the host gateway, or directly with explicit unknown-outcome reporting. */
export async function sendBcfWrite<T extends { guid: string }>(
  ctx: Ctx,
  intent: BcfWriteIntent,
  send: () => Promise<T>,
  secrets: readonly string[] = [],
): Promise<T> {
  const gateway = ctx.host.bcfWrites;
  // Enrol the actual resolved bearer, including short literal/Player values.
  // Structural identifiers cannot be redacted without changing the object they name.
  const redaction = new Map(secrets.filter(secret => secret.length > 0).flatMap(secret =>
    [...new Set([secret, JSON.stringify(secret).slice(1, -1)])].map(value => [value, '[REDACTED]'] as const)));
  const checkedReceipt = (result: T): T => {
    if (!result || typeof result.guid !== 'string' || result.guid.length === 0) {
      throw new Error('BCF server receipt has no valid identifier; the server outcome is unknown.');
    }
    if ([...redaction.keys()].some(secret => result.guid.includes(secret))) {
      throw new Error('BCF server receipt contains credential text; the server outcome is unknown.');
    }
    return result;
  };
  // Check before an owned gateway settles the real send, and also when another
  // gateway returns its own receipt without forwarding this callback.
  const checkedSend = async (): Promise<T> => checkedReceipt(await send());
  const redactedReceipt = (result: T): T => {
    const guid = checkedReceipt(result).guid;
    const fields = { ...result };
    Reflect.deleteProperty(fields, 'guid');
    // `guid` is a fixed protocol key, not echoed credential data. Even a bearer
    // equal to this key must leave the validated identifier usable downstream.
    return Object.assign(redactDeep(fields, redaction), { guid });
  };
  if (gateway) {
    try { return redactedReceipt(await gateway.write(intent, checkedSend, secrets)); }
    catch (error) {
      // Keep host-owned recovery/refusal semantics; never propagate an opaque raw cause.
      throw new Error(redactText(error instanceof Error ? error.message : String(error), redaction));
    }
  }
  try {
    return redactedReceipt(await checkedSend());
  } catch (err) {
    // Use the same dispatch/status provenance as both durable publication hosts.
    const classified = classifyWriteError(err, new Date().toISOString());
    if (err instanceof NetworkDeniedError && err.dispatched === false) {
      // This diagnostic is produced locally before dispatch; preserve it without its cause.
      throw new Error(`${intent.nodeType}: ${redactText(err.message, redaction)}`);
    }
    const status = classified.failure.status === undefined ? '' : `, HTTP ${classified.failure.status}`;
    const context = `${classified.failure.code}${status}`;
    const message = classified.state === 'failed'
      ? `${intent.nodeType}: request refused (${context}).`
      : `${intent.nodeType}: outcome unknown — the server may have applied this ${intent.operation} (${context}). Check the project before running this node again.`;
    // Server bodies/URLs and the original cause may echo a literal/Player bearer.
    throw new Error(redactText(message, redaction));
  }
}
