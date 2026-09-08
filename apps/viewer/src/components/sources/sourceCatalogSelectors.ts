/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PagedItems } from './sourceCatalogPaging';

/** The file area a catalog's pages were fetched for. */
export interface CatalogArea {
  readonly projectId: string;
  readonly fileAreaId: string;
}

/**
 * Flattens every page into one list, last write wins per id. Pages from
 * different parents can repeat an entity (a folder reached two ways), so the
 * flattening must dedupe rather than concatenate.
 */
export function collectUniqueById<T extends { id: string }>(pages: Iterable<PagedItems<T>>): T[] {
  const byId = new Map<string, T>();
  for (const page of pages) {
    for (const item of page.items) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/**
 * True when every fetched listing is complete (no cursor outstanding). Only
 * then can "folder X has no files" be asserted for UI gating.
 */
export function isCatalogComplete(
  containersByParent: ReadonlyMap<string, PagedItems<unknown>>,
  filesByContainer: ReadonlyMap<string, PagedItems<unknown>>,
): boolean {
  for (const page of containersByParent.values()) if (page.cursor !== undefined) return false;
  for (const page of filesByContainer.values()) if (page.cursor !== undefined) return false;
  return containersByParent.size > 0 || filesByContainer.size > 0;
}

/**
 * The map key holding the current selection's entities.
 *
 * `keyedByArea` reflects the provider capability that decides the layout of the
 * map: one entry per file area (`flat-subtree` folders, recursive files) versus
 * one entry per browsed container. Area-keyed maps ignore the selection; the
 * per-container ones fall back to the area root when nothing is selected.
 */
export function resolveCatalogKey(
  area: CatalogArea | null,
  selectedContainerId: string | null,
  keyedByArea: boolean,
): string | null {
  if (!area) return null;
  return keyedByArea ? area.fileAreaId : (selectedContainerId ?? area.fileAreaId);
}

/** True when the page at `key` has an outstanding cursor, i.e. "Load more" applies. */
export function pageHasMore(
  pages: ReadonlyMap<string, PagedItems<unknown>>,
  key: string | null,
): boolean {
  return key !== null && pages.get(key)?.cursor !== undefined;
}
