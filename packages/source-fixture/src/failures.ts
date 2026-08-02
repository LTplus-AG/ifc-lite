/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Page } from '@ifc-lite/plugin-api';

import { FixtureApiError, hangUntilAborted } from './errors.js';

/** Every provider method the fixture can be told to misbehave on. */
export type FixtureMethodName =
  | 'listProjects'
  | 'listContainers'
  | 'listFiles'
  | 'download'
  | 'listRevisions'
  | 'watchRevisions'
  | 'searchFiles'
  | 'testConnection';

/**
 * `throw` — rejects immediately with a plain error (and optional HTTP-shaped
 * status).
 *
 * `rate-limit` — rejects with a 429-shaped `FixtureApiError`, `retryAfter`
 * populated, standing in for a real CDE's throttling response.
 *
 * `hang` — never settles until the caller's `AbortSignal` fires, so a test
 * can assert the provider actually wires `signal` through instead of
 * ignoring it.
 *
 * `truncate` — returns fewer items than the page's own cursor math promises,
 * simulating a provider whose pagination is internally inconsistent. Only
 * meaningful on paging methods; applied after the real page is computed.
 */
export type InjectedFailure =
  | { readonly kind: 'throw'; readonly message?: string; readonly status?: number }
  | { readonly kind: 'rate-limit'; readonly retryAfterSeconds?: number }
  | { readonly kind: 'hang' }
  | { readonly kind: 'truncate'; readonly keep: number };

/**
 * Applies every failure kind except `'truncate'` (which needs the already-
 * computed page and is handled by {@link applyTruncate} instead). Resolves
 * normally when there is nothing to inject.
 */
export async function applyBlockingFailure(
  failure: InjectedFailure | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!failure) return;
  switch (failure.kind) {
    case 'throw':
      throw new FixtureApiError(failure.message ?? 'Injected failure', failure.status);
    case 'rate-limit':
      throw new FixtureApiError('Rate limited', 429, failure.retryAfterSeconds ?? 1);
    case 'hang':
      await hangUntilAborted(signal);
      return;
    case 'truncate':
      return; // handled post-hoc by applyTruncate
  }
}

/** Shrinks a computed page to `keep` items while leaving its cursor intact. */
export function applyTruncate<T>(page: Page<T>, failure: InjectedFailure | undefined): Page<T> {
  if (!failure || failure.kind !== 'truncate') return page;
  const keep = Math.max(0, Math.min(failure.keep, page.items.length));
  return { items: page.items.slice(0, keep), cursor: page.cursor };
}
