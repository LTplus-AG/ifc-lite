/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Registry webhooks (08-review.md §8.7, 10-registry.md §10.1): the
 * async/notification surface. The registry emits an event after each
 * state change — layer pushed, ref moved, merged (attended or auto),
 * review opened/updated/commented — and GitHub-style consumers (email,
 * Slack, a nightly agent) subscribe with a URL.
 *
 * Delivery is fire-and-forget with one retry: a webhook consumer must
 * never be able to block or fail a registry write. Payloads are signed
 * with HMAC-SHA256 over the raw body (`x-ifclite-signature:
 * sha256=<hex>`) so consumers can verify origin without transport trust.
 */

import * as crypto from 'node:crypto';

export interface RegistryWebhook {
  url: string;
  /** HMAC-SHA256 signing secret; unsigned delivery when omitted. */
  secret?: string;
}

export type RegistryEventType =
  | 'layer.pushed'
  | 'ref.moved'
  | 'ref.merged'
  | 'review.opened'
  | 'review.updated'
  | 'review.commented';

export interface RegistryEvent {
  event: RegistryEventType;
  /** ISO-8601 emission time. */
  emitted_at: string;
  data: Record<string, unknown>;
}

export function signRegistryEvent(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body, 'utf-8').digest('hex')}`;
}

const DELIVERY_TIMEOUT_MS = 5_000;

async function deliver(hook: RegistryWebhook, body: string): Promise<boolean> {
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(hook.secret ? { 'x-ifclite-signature': signRegistryEvent(hook.secret, body) } : {}),
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Emit an event to every configured webhook. Async and error-swallowing
 * BY CONTRACT: callers fire this after the response is decided; a dead
 * consumer costs one retry and a warning, never a failed registry write.
 */
export function emitRegistryEvent(
  hooks: readonly RegistryWebhook[],
  event: RegistryEventType,
  data: Record<string, unknown>
): void {
  if (hooks.length === 0) return;
  const body = JSON.stringify({
    event,
    emitted_at: new Date().toISOString(),
    data,
  } satisfies RegistryEvent);
  for (const hook of hooks) {
    void (async () => {
      if (await deliver(hook, body)) return;
      if (await deliver(hook, body)) return;
      // eslint-disable-next-line no-console
      console.warn(`[layer-registry] webhook delivery failed twice: ${event} → ${hook.url}`);
    })();
  }
}
