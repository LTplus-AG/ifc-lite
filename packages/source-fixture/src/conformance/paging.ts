/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'vitest';
import type { FileSourceProvider, Page, PluginContext } from '@ifc-lite/plugin-api';

import { assertNoDuplicateIds, assertSameIdSet, collectAllPages } from './collect.js';
import type { ConformanceFixtures } from './types.js';

/**
 * For every paging method the provider exposes: paging terminates, no item
 * is ever repeated across pages, and following cursors with a small page
 * limit reconstructs the exact same id set as one large-limit call — the "at
 * minimum" bar for cursor correctness. This is deliberately the *portable*
 * subset of pagination correctness: it holds for any conformant provider's
 * own cursor scheme, unlike asserting a specific rejection behavior for a
 * cursor reused across unrelated queries (which the fixture's own tests
 * cover, since that's an implementation choice rather than part of the
 * contract every provider must share).
 */
export function describePagingConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: ConformanceFixtures,
  smallPageLimit: number,
): void {
  describe('paging', () => {
    async function checkPagingProperty<T extends { id: string }>(
      label: string,
      fetchPage: (request: { cursor?: string; limit?: number }) => Promise<Page<T>>,
    ): Promise<void> {
      const bulk = await collectAllPages(fetchPage, 10_000);
      const paged = await collectAllPages(fetchPage, smallPageLimit);
      assertNoDuplicateIds(paged, label);
      assertSameIdSet(paged, bulk, label);
    }

    it('listProjects: terminates, dedups, and reconstructs the bulk result', async () => {
      const ctx = createContext();
      await checkPagingProperty('listProjects', (request) => provider.listProjects(ctx, request));
    });

    it('listContainers: terminates, dedups, and reconstructs the bulk result', async () => {
      const ctx = createContext();
      await checkPagingProperty('listContainers', (request) =>
        provider.listContainers(ctx, fixtures.projectId, undefined, request),
      );
    });

    it('listFiles: terminates, dedups, and reconstructs the bulk result', async () => {
      const ctx = createContext();
      await checkPagingProperty('listFiles', (request) =>
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

    it.runIf(provider.manifest.capabilities.revisionHistory && fixtures.fileWithRevisions !== undefined)(
      'listRevisions: terminates, dedups, and reconstructs the bulk result',
      async () => {
        const ctx = createContext();
        const ref = { projectId: fixtures.projectId, ...fixtures.fileWithRevisions! };
        await checkPagingProperty('listRevisions', (request) => provider.listRevisions!(ctx, ref, request));
      },
    );
  });
}
