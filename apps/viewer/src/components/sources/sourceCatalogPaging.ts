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

/** Appends a freshly fetched page to the pages already held for the same key. */
export function appendPage<T>(current: PagedItems<T>, page: PagedItems<T>): PagedItems<T> {
  return { items: [...current.items, ...page.items], cursor: page.cursor };
}
