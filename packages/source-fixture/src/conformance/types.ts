/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';

/** A file the suite can address by its full `SourceFileRef` coordinates. */
export interface ConformanceFileRef {
  readonly containerId: string;
  readonly fileId: string;
}

/**
 * Known-good ids the suite exercises the provider against. None of this is
 * guessed or discovered — the caller must supply ids that genuinely exist in
 * whatever the provider under test is backed by, mirroring how a real
 * conformance run would be pointed at a seeded sandbox tenant.
 */
export interface ConformanceFixtures {
  readonly projectId: string;
  /**
   * A container with at least one nested child container. Omit if the data
   * behind this provider has no container nesting to test — the
   * containerListing-mode checks are skipped in that case.
   */
  readonly containerWithChildrenId?: string;
  /** A container with at least one file, directly or (when `listFilesIsRecursive`) in a descendant. */
  readonly containerWithFilesId: string;
  /**
   * A file with 2+ revisions, used to prove `download` and `listRevisions`
   * honor `revisionId`. Omit to skip the revision-specific checks (e.g. a
   * provider with no revision history at all).
   */
  readonly fileWithRevisions?: ConformanceFileRef;
  /** A query expected to match at least one file in `projectId`, for `searchFiles`. */
  readonly searchQuery?: string;
  /**
   * A second, distinct project id the provider also exposes under
   * `listProjects` — a project of its own, unrelated to `projectId`, not a
   * container or file within it. Every other conformance check is scoped to
   * `projectId` alone and never sees this one.
   *
   * Omit to skip the multi-page `listProjects` check. With only `projectId`
   * known, the suite has no second project to force a real page boundary
   * with, so `listProjects`'s cursor-following would otherwise be asserted
   * only against a single-item, single-page result — passing even against a
   * provider whose `listProjects` pagination is completely broken (see the
   * ifc-lite source-dalux/source-fixture conformance audit, 2026-08-06).
   */
  readonly secondProjectId?: string;
}

/**
 * How the suite forces a listing across a real page boundary.
 *
 * `ListOptions.limit` is documented as "Hint only; providers clamp to
 * whatever their API allows" — so a provider that never forwards it is
 * *conformant*, and the suite must not fail it for that. `DaluxBuildProvider`
 * is exactly that provider: Dalux pages by minting an opaque `bookmark`, the
 * caller has no say in the page size, and nothing in the request carries
 * `limit` at all.
 *
 * - `'limit'` (default) — the provider honors `limit` (clamping down is
 *   fine), so passing `smallPageLimit` is enough to split the result set.
 * - `'backend'` — the provider treats `limit` as the hint it is. Nothing the
 *   suite passes can split a page, so the *caller* must seed the backing
 *   data or mock API so the provider's own server-side page size is smaller
 *   than the fixture result sets. The suite then pages with no limit at all
 *   and still requires more than one request, which is the assertion that
 *   was ever worth making: cursor-following works.
 */
export type PageBoundaryMode = 'limit' | 'backend';

export interface ConformanceOptions {
  /** Produces a fresh `PluginContext` per call — some checks need isolated storage (e.g. auth state). */
  readonly createContext: () => PluginContext;
  readonly fixtures: ConformanceFixtures;
  /**
   * Page size small enough to force multiple pages against the fixtures
   * above. Default `1`. Ignored under `pageBoundary: 'backend'`, where the
   * provider is declared not to honor `limit` in the first place.
   */
  readonly smallPageLimit?: number;
  /** Default `'limit'`. See {@link PageBoundaryMode}. */
  readonly pageBoundary?: PageBoundaryMode;
  /**
   * `true` when the provider is backed by a delta/change feed, so
   * `watchRevisions` can hand back a resumable token.
   *
   * Default `false`, because `RevisionWatchResult.cursor` is optional in the
   * contract and documented as what "providers with a delta endpoint" return
   * — a polling provider (Dalux: no delta endpoint, every call re-sweeps the
   * given refs) has nothing to resume from and correctly returns none.
   * Requiring one unconditionally, as this suite once did, failed a provider
   * that was behaving exactly as specified.
   */
  readonly watchRevisionsHasDeltaFeed?: boolean;
}
