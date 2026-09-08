/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ProviderCapabilities, SourceContainer, SourceFile } from '@ifc-lite/plugin-api';
import { loadSourceCatalogCache, saveSourceCatalogCache } from '@/lib/sources/persistence';
import type { PagedItems } from './sourceCatalogPaging';

/** Identifies the one file area a cache entry belongs to. */
export interface CatalogCacheScope {
  readonly providerName: string;
  readonly projectId: string;
  readonly fileAreaId: string;
}

/**
 * Only providers that return a whole file area in one listing can be cached:
 * their catalog is either complete or visibly partial. Per-folder providers
 * accumulate the area folder by folder, so what is in memory is never known to
 * be the whole area and must not be written back as if it were.
 */
export function isCatalogCacheable(capabilities: ProviderCapabilities): boolean {
  return capabilities.containerListing === 'flat-subtree' && capabilities.listFilesIsRecursive;
}

/**
 * Persists the catalog when (and only when) it is completely fetched — partial
 * pages must not masquerade as the whole area next session.
 *
 * @returns the entry's `updatedAt`, or `null` when nothing was written.
 */
export function persistCompleteCatalog(
  scope: CatalogCacheScope,
  containers: ReadonlyMap<string, PagedItems<SourceContainer>>,
  files: ReadonlyMap<string, PagedItems<SourceFile>>,
): number | null {
  const containerPage = containers.get(scope.fileAreaId);
  const filePage = files.get(scope.fileAreaId);
  if (!containerPage || !filePage) return null;
  if (containerPage.cursor !== undefined || filePage.cursor !== undefined) return null;
  const entry = saveSourceCatalogCache(
    scope.providerName,
    scope.projectId,
    scope.fileAreaId,
    containerPage.items,
    filePage.items,
  );
  return entry.updatedAt;
}

export interface CachedCatalog {
  readonly containersByParent: Map<string, PagedItems<SourceContainer>>;
  readonly filesByContainer: Map<string, PagedItems<SourceFile>>;
  readonly updatedAt: number;
}

/**
 * Reads a cached catalog back as the two page maps the hook holds in state.
 * Cached pages carry no cursor: a cache entry only ever exists for a fully
 * fetched area.
 */
export function readCachedCatalog(scope: CatalogCacheScope): CachedCatalog | null {
  const cached = loadSourceCatalogCache(scope.providerName, scope.projectId, scope.fileAreaId);
  if (!cached) return null;
  return {
    containersByParent: new Map([[scope.fileAreaId, { items: [...cached.folders] }]]),
    filesByContainer: new Map([[scope.fileAreaId, { items: [...cached.files] }]]),
    updatedAt: cached.updatedAt,
  };
}
