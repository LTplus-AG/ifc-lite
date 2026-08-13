/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { FileSourceProvider, Page, PluginContext } from '@ifc-lite/plugin-api';

import { assertNoDuplicateIds, assertSameIdSet, collectAllPages } from './collect.js';
import type { ConformanceFixtures, PageBoundaryMode } from './types.js';

/**
 * For every paging method the provider exposes: paging terminates, no item
 * is ever repeated across pages, and following cursors to exhaustion
 * reconstructs the exact same id set twice over — the "at minimum" bar for
 * cursor correctness. This is deliberately the *portable* subset of
 * pagination correctness: it holds for any conformant provider's own cursor
 * scheme, unlike asserting a specific rejection behavior for a cursor reused
 * across unrelated queries (which the fixture's own tests cover, since that's
 * an implementation choice rather than part of the contract every provider
 * must share).
 *
 * How pages are made to split depends on `pageBoundary` — see
 * {@link PageBoundaryMode}. Nothing here may require the provider to honor
 * `ListOptions.limit`, which the contract defines as a hint.
 */
export function describePagingConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: ConformanceFixtures,
  smallPageLimit: number,
  pageBoundary: PageBoundaryMode,
): void {
  // Under `'backend'` the provider is declared not to honor `limit`, so the
  // suite stops passing one: page size is the backing API's own choice, and
  // the caller is responsible for seeding it small enough to split. Passing
  // a limit anyway would not be merely useless — it would quietly describe
  // the run as testing something it is not.
  const boundaryLimit = pageBoundary === 'limit' ? smallPageLimit : undefined;
  const bulkLimit = pageBoundary === 'limit' ? 10_000 : undefined;

  describe('paging', () => {
    async function checkPagingProperty<T extends { id: string }>(
      label: string,
      fetchPage: (request: { cursor?: string; limit?: number }) => Promise<Page<T>>,
    ): Promise<void> {
      const bulk = await collectAllPages(fetchPage, bulkLimit);
      const paged = await collectAllPages(fetchPage, boundaryLimit);
      assertNoDuplicateIds(paged, label);
      assertSameIdSet(paged, bulk, label);
    }

    // Shared tail for the "a real page boundary forces cursor-following to
    // work" companion checks below: given a `bulk` result already known to
    // have 2+ items, proves the run actually forces more than one request
    // and that the paged result still reconstructs `bulk` exactly.
    // Factored out so the four categories below reuse the same assertions
    // `listProjects` already had instead of four near-identical copies —
    // duplication is exactly what let this check drift onto only one branch
    // in the first place.
    async function assertPagingCrossesBoundary<T extends { id: string }>(
      label: string,
      fetchPage: (request: { cursor?: string; limit?: number }) => Promise<Page<T>>,
      bulk: readonly T[],
    ): Promise<void> {
      // Only meaningful when the boundary is supposed to come from `limit`:
      // having 2+ items is necessary but NOT sufficient, because a page limit
      // that can hold them all still satisfies the id-set assertion below
      // without ever crossing a boundary. Under `'backend'` the suite passes
      // no limit at all, so there is no such inequality to check — the
      // request count below is the whole assertion.
      if (pageBoundary === 'limit') {
        expect(
          smallPageLimit,
          `smallPageLimit (${smallPageLimit}) must be smaller than the ${bulk.length} ${label} items ` +
            `available, or a single response satisfies this check and paging is never exercised`,
        ).toBeLessThan(bulk.length);
      }

      // Count the requests: crossing a real page boundary means more than
      // one. In `'limit'` mode the inequality above is not enough on its own,
      // since a provider may clamp `limit` upward or ignore it; in
      // `'backend'` mode this is the only thing being measured.
      let requestCount = 0;
      const paged = await collectAllPages((request) => {
        requestCount += 1;
        return fetchPage(request);
      }, boundaryLimit);
      expect(
        requestCount,
        pageBoundary === 'limit'
          ? `${label} answered in a single response despite a page limit smaller than the result ` +
              "set — its `limit`/cursor handling is not being exercised"
          : `${label} answered all ${bulk.length} item(s) in a single response. Under ` +
              "pageBoundary: 'backend' the suite passes no `limit` (the contract makes it a hint " +
              'the provider is free to ignore), so the fixture data or mock API behind this ' +
              "provider must be seeded so the provider's own server-side page size is smaller " +
              `than ${bulk.length} — otherwise cursor-following is never exercised`,
      ).toBeGreaterThan(1);

      assertNoDuplicateIds(paged, `${label} (multi-page)`);
      assertSameIdSet(paged, bulk, `${label} (multi-page)`);
    }

    // Companion to `checkPagingProperty` above: fetches the bulk result,
    // requires it to actually have 2+ items (the gap `checkPagingProperty`
    // alone doesn't cover — see `ConformanceFixtures` doc comment), then
    // forces and verifies a real page boundary via `assertPagingCrossesBoundary`.
    async function checkPagingForcesBoundary<T extends { id: string }>(
      label: string,
      fetchPage: (request: { cursor?: string; limit?: number }) => Promise<Page<T>>,
    ): Promise<void> {
      const bulk = await collectAllPages(fetchPage, bulkLimit);
      expect(
        bulk.length,
        `${label}: fixture must supply at least 2 items to force a real page boundary`,
      ).toBeGreaterThanOrEqual(2);
      await assertPagingCrossesBoundary(label, fetchPage, bulk);
    }

    it('listProjects: terminates, dedups, and reconstructs the bulk result', async () => {
      const ctx = createContext();
      await checkPagingProperty('listProjects', (request) => provider.listProjects(ctx, request));
    });

    // Deliberately separate from the check above rather than folded into it:
    // `fixtures.projectId` alone never gives `listProjects` a second item to
    // page past, so that check above passes even against a provider whose
    // listProjects cursor handling is completely broken — it only ever sees
    // one page. This test is what actually forces a page boundary and proves
    // cursor-following works, gated on the caller supplying a genuine second
    // project id to page against.
    it.runIf(fixtures.secondProjectId !== undefined)(
      'listProjects: a second project forces a real page boundary, and cursor-following survives it',
      async () => {
        const ctx = createContext();
        const bulk = await collectAllPages((request) => provider.listProjects(ctx, request), bulkLimit);
        expect(
          bulk.length,
          'fixture must supply a secondProjectId distinct from every other known project',
        ).toBeGreaterThanOrEqual(2);
        expect(
          bulk.some((project) => project.id === fixtures.secondProjectId),
          `secondProjectId ${fixtures.secondProjectId} did not appear in listProjects' results`,
        ).toBe(true);
        await assertPagingCrossesBoundary('listProjects', (request) => provider.listProjects(ctx, request), bulk);
      },
    );

    it('listContainers: terminates, dedups, and reconstructs the bulk result', async () => {
      const ctx = createContext();
      await checkPagingProperty('listContainers', (request) =>
        provider.listContainers(ctx, fixtures.projectId, undefined, request),
      );
    });

    // Companion to the check above — see the `checkPagingForcesBoundary` doc
    // comment and the `listProjects` companion test earlier in this file:
    // without this, a fixture world with exactly one container at this level
    // would pass the check above vacuously, never exercising cursor-following
    // at all.
    it('listContainers: a real page boundary forces cursor-following to work', async () => {
      const ctx = createContext();
      await checkPagingForcesBoundary('listContainers', (request) =>
        provider.listContainers(ctx, fixtures.projectId, undefined, request),
      );
    });

    it('listFiles: terminates, dedups, and reconstructs the bulk result', async () => {
      const ctx = createContext();
      await checkPagingProperty('listFiles', (request) =>
        provider.listFiles(ctx, fixtures.projectId, fixtures.containerWithFilesId, undefined, request),
      );
    });

    it('listFiles: a real page boundary forces cursor-following to work', async () => {
      const ctx = createContext();
      await checkPagingForcesBoundary('listFiles', (request) =>
        provider.listFiles(ctx, fixtures.projectId, fixtures.containerWithFilesId, undefined, request),
      );
    });

    it.runIf(provider.manifest.capabilities.search && fixtures.searchQuery !== undefined)(
      'searchFiles: terminates, dedups, and reconstructs the bulk result',
      async () => {
        const ctx = createContext();
        await checkPagingProperty('searchFiles', (request) =>
          provider.searchFiles!(ctx, fixtures.projectId, fixtures.searchQuery!, undefined, request),
        );
      },
    );

    it.runIf(provider.manifest.capabilities.search && fixtures.searchQuery !== undefined)(
      'searchFiles: a real page boundary forces cursor-following to work',
      async () => {
        const ctx = createContext();
        await checkPagingForcesBoundary('searchFiles', (request) =>
          provider.searchFiles!(ctx, fixtures.projectId, fixtures.searchQuery!, undefined, request),
        );
      },
    );

    it.runIf(provider.manifest.capabilities.revisionHistory && fixtures.fileWithRevisions !== undefined)(
      'listRevisions: terminates, dedups, and reconstructs the bulk result',
      async () => {
        const ctx = createContext();
        const ref = { projectId: fixtures.projectId, ...fixtures.fileWithRevisions! };
        await checkPagingProperty('listRevisions', (request) => provider.listRevisions!(ctx, ref, request));
      },
    );

    it.runIf(provider.manifest.capabilities.revisionHistory && fixtures.fileWithRevisions !== undefined)(
      'listRevisions: a real page boundary forces cursor-following to work',
      async () => {
        const ctx = createContext();
        const ref = { projectId: fixtures.projectId, ...fixtures.fileWithRevisions! };
        await checkPagingForcesBoundary('listRevisions', (request) => provider.listRevisions!(ctx, ref, request));
      },
    );
  });
}
