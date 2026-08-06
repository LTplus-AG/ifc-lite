/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FileSourceProvider, PluginContext, SourceContainer, SourceFile } from '@ifc-lite/plugin-api';

export const IFC_NAME_PATTERNS = ['*.ifc', '*.ifcx', '*.ifc5'];
export const LIST_PAGE_LIMIT = 200;

/** One cursor-paged slice of a listing. `cursor === undefined` means "no more". */
export interface PagedItems<T> {
  readonly items: readonly T[];
  readonly cursor?: string;
}

export async function fetchContainerPage(
  provider: FileSourceProvider,
  ctx: PluginContext,
  projectId: string,
  parentKey: string,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<PagedItems<SourceContainer>> {
  const page = await provider.listContainers(ctx, projectId, parentKey, {
    cursor,
    limit: LIST_PAGE_LIMIT,
    signal,
  });
  // Providers may omit `parentId` on direct children; normalise so the
  // client-side tree always has a link back to the queried parent.
  const items = page.items.map((container) =>
    container.parentId === undefined ? { ...container, parentId: parentKey } : container,
  );
  return { items, cursor: page.cursor } satisfies PagedItems<SourceContainer>;
}

export async function fetchFilePage(
  provider: FileSourceProvider,
  ctx: PluginContext,
  projectId: string,
  containerId: string,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<PagedItems<SourceFile>> {
  const page = await provider.listFiles(
    ctx,
    projectId,
    containerId,
    { namePatterns: IFC_NAME_PATTERNS },
    { cursor, limit: LIST_PAGE_LIMIT, signal },
  );
  return { items: [...page.items], cursor: page.cursor } satisfies PagedItems<SourceFile>;
}

/** Hard ceiling on pages swept by {@link fetchAllFilePages}. A provider that
 * keeps minting fresh cursors (buggy or malicious) would otherwise loop
 * forever; this trades a clear failure for an unbounded hang. */
const MAX_FILE_SWEEP_PAGES = 500;

/**
 * Follows every page of a container's file listing and returns them combined,
 * with `cursor` always `undefined` — there's no source (currently just Dalux)
 * where "browse this folder, then manually load more files" is a real user
 * concept; Dalux's own UI just shows a folder's files, all of them. Manual
 * per-folder file pagination in the viewer papered over that mismatch instead
 * of resolving it, so folder file listings are swept in full up front instead.
 *
 * Distinct from `search.ts`'s own load-more, which paginates true
 * provider-side search results (a different, legitimately incremental UX) —
 * this only replaces the plain "browse a folder's files" path.
 */
export async function fetchAllFilePages(
  provider: FileSourceProvider,
  ctx: PluginContext,
  projectId: string,
  containerId: string,
  signal: AbortSignal,
): Promise<PagedItems<SourceFile>> {
  let page = await fetchFilePage(provider, ctx, projectId, containerId, undefined, signal);
  let items = page.items;
  let pageCount = 1;

  while (page.cursor !== undefined) {
    pageCount += 1;
    if (pageCount > MAX_FILE_SWEEP_PAGES) {
      throw new Error(`Listing files at ${containerId} exceeded ${MAX_FILE_SWEEP_PAGES} pages without finishing`);
    }
    page = await fetchFilePage(provider, ctx, projectId, containerId, page.cursor, signal);
    items = [...items, ...page.items];
  }

  return { items, cursor: undefined } satisfies PagedItems<SourceFile>;
}

/** Appends a freshly fetched page to the pages already held for the same key. */
export function appendPage<T>(current: PagedItems<T>, page: PagedItems<T>): PagedItems<T> {
  return { items: [...current.items, ...page.items], cursor: page.cursor };
}
