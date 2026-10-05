/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hosted-proxy request quota (free tier). The proxy reports it on every chat
 * response (`X-Usage-*` headers) and on `GET <proxy>?usage=1`, whose body is
 * `{ usage: { type, used, limit, pct, resetAt } }`.
 */

import type { UsageInfo } from './stream-client.js';

export type UsageSnapshotResult = { ok: true; usage: UsageInfo } | { ok: false; reason: string };

export function parseUsageFromHeaders(headers: Headers): UsageInfo | null {
  const creditsUsed = parseInt(headers.get('X-Credits-Used') ?? '0', 10);
  const creditsLimit = parseInt(headers.get('X-Credits-Limit') ?? '0', 10);
  const usageUsed = parseInt(headers.get('X-Usage-Used') ?? '0', 10);
  const usageLimit = parseInt(headers.get('X-Usage-Limit') ?? '0', 10);

  if (creditsLimit > 0) {
    const billable = headers.get('X-Credits-Billable');
    return {
      type: 'credits',
      used: creditsUsed,
      limit: creditsLimit,
      pct: parseInt(headers.get('X-Credits-Pct') ?? '0', 10),
      resetAt: parseInt(headers.get('X-Credits-Reset') ?? '0', 10),
      billable: billable === null ? undefined : billable === 'true',
    };
  }

  if (usageLimit > 0) {
    return {
      type: 'requests',
      used: usageUsed,
      limit: usageLimit,
      pct: parseInt(headers.get('X-Usage-Pct') ?? '0', 10),
      resetAt: parseInt(headers.get('X-Usage-Reset') ?? '0', 10),
    };
  }

  return null;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** The JSON body of `GET ?usage=1`; null when it is not the documented shape. */
export function parseUsageBody(body: unknown): UsageInfo | null {
  const usage = body && typeof body === 'object' ? (body as { usage?: unknown }).usage : undefined;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  if ((u.type !== 'requests' && u.type !== 'credits') || !finite(u.used) || !finite(u.limit) || u.limit <= 0
    || !finite(u.pct) || !finite(u.resetAt)) return null;
  return { type: u.type, used: u.used, limit: u.limit, pct: u.pct, resetAt: u.resetAt,
    ...(typeof u.billable === 'boolean' ? { billable: u.billable } : {}) };
}

async function readSnapshot(response: Response): Promise<UsageInfo | null> {
  try {
    const fromBody = parseUsageBody(await response.clone().json());
    if (fromBody) return fromBody;
  } catch (error) {
    console.debug('[usage] snapshot body is not JSON; reading headers', error);
  }
  return parseUsageFromHeaders(response.headers);
}

/**
 * Fetch the current quota without sending a chat message. Failures are logged
 * and returned as a reason so the UI can say "unknown" instead of hiding it.
 */
let lastFailure: string | null = null;

export async function fetchUsageSnapshot(proxyUrl: string): Promise<UsageSnapshotResult> {
  const isDev = Boolean((import.meta as unknown as { env?: Record<string, unknown> }).env?.DEV);
  const snapshotUrl = `${proxyUrl}${proxyUrl.includes('?') ? '&' : '?'}usage=1`;
  const appSnapshotUrl = '/api/chat?usage=1';
  const canFallbackToAppProxy = isDev && snapshotUrl !== appSnapshotUrl;
  const fetchSnapshot = (url: string) => fetch(url, { method: 'GET' });
  const fail = (reason: string, error?: unknown): UsageSnapshotResult => {
    // Polled on an interval: report each distinct failure once, not every tick.
    if (lastFailure !== reason) console.warn(`[usage] quota snapshot unavailable: ${reason}`, ...(error === undefined ? [] : [error]));
    lastFailure = reason;
    return { ok: false, reason };
  };

  let response: Response;
  try {
    response = await fetchSnapshot(snapshotUrl);
  } catch (error) {
    if (!canFallbackToAppProxy) return fail('network error', error);
    try {
      response = await fetchSnapshot(appSnapshotUrl);
    } catch (fallbackError) {
      return fail('network error', fallbackError);
    }
  }

  // Local dev resilience: a stale `vercel dev` URL 404s; retry the app proxy once.
  if (!response.ok && response.status === 404 && canFallbackToAppProxy) {
    try {
      const retry = await fetchSnapshot(appSnapshotUrl);
      if (retry.ok || retry.status !== 404) response = retry;
    } catch (error) {
      console.debug('[usage] app proxy fallback failed; keeping the original response', error);
    }
  }

  if (!response.ok) return fail(`HTTP ${response.status}`);
  const usage = await readSnapshot(response);
  if (!usage) return fail('response carried no usage');
  lastFailure = null;
  return { ok: true, usage };
}
