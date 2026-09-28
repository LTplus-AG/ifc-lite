/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CommitSourceErrorCode, Page } from '@ifc-lite/plugin-api';

import { FixtureApiError, FixtureCommitError, hangUntilAborted } from './errors.js';

/** Every provider method the fixture can be told to misbehave on. */
export type FixtureMethodName =
  | 'listProjects'
  | 'listContainers'
  | 'listFiles'
  | 'download'
  | 'listRevisions'
  | 'watchRevisions'
  | 'searchFiles'
  | 'testConnection'
  // Contract 2.1.0. Listed here so `setFailure` covers the commit surface
  // exactly as it covers the file surface — a host's commit error handling
  // is no less worth exercising than its download error handling.
  | 'listModels'
  | 'getModel'
  | 'listCommits'
  | 'getCommit'
  | 'loadCommit'
  | 'loadCommitFingerprints'
  | 'getCommitDiff'
  | 'listElementHistory'
  | 'listIdentityRecords'
  | 'createModel'
  | 'createCommit'
  | 'recordIdentity'
  | 'watchCommits';

/**
 * `throw` — rejects immediately with a plain error (and optional HTTP-shaped
 * status). Pass `code` to reject with a `FixtureCommitError` instead, so a
 * host's `isCommitSourceError` branching (`forbidden` reads differently from
 * a transient failure — there is nothing to retry) can be exercised.
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
  | {
      readonly kind: 'throw';
      readonly message?: string;
      readonly status?: number;
      readonly code?: CommitSourceErrorCode;
      readonly details?: Readonly<Record<string, unknown>>;
    }
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
      if (failure.code !== undefined) {
        throw new FixtureCommitError(failure.code, failure.message ?? 'Injected failure', {
          ...(failure.status !== undefined ? { status: failure.status } : {}),
          ...(failure.details !== undefined ? { details: failure.details } : {}),
        });
      }
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
