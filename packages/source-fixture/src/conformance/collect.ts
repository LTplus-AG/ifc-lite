/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FileSourceProvider, Page, PluginContext } from '@ifc-lite/plugin-api';

const MAX_PAGES = 10_000;

/**
 * Follows `cursor` to exhaustion, asserting termination as it goes (a
 * provider that never returns `cursor: undefined` would otherwise hang the
 * test suite instead of failing it). Returns every item concatenated across
 * pages, in order.
 */
export async function collectAllPages<T>(
  fetchPage: (request: { cursor?: string; limit?: number }) => Promise<Page<T>>,
  limit: number | undefined,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let pageCount = 0; pageCount <= MAX_PAGES; pageCount++) {
    const page = await fetchPage({ cursor, limit });
    items.push(...page.items);
    if (page.cursor === undefined) return items;
    cursor = page.cursor;
  }
  throw new Error(
    `paging did not terminate within ${MAX_PAGES} pages — cursor kept coming back non-undefined`,
  );
}

/** Extracts `.id` from every item — the common key for uniqueness/dedup checks below. */
function ids<T extends { id: string }>(items: readonly T[]): string[] {
  return items.map((item) => item.id);
}

/** Throws with a readable message if any id repeats. */
export function assertNoDuplicateIds<T extends { id: string }>(items: readonly T[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids(items)) {
    if (seen.has(id)) throw new Error(`${label}: id ${id} was returned more than once across pages`);
    seen.add(id);
  }
}

/**
 * Asserts that following cursors with a small page limit yields the same set
 * of ids as a single large-limit call — the "at minimum" bar for cursor
 * correctness: paging must reconstruct the same total result the provider
 * would give in one shot.
 */
export function assertSameIdSet<T extends { id: string }>(
  paged: readonly T[],
  bulk: readonly T[],
  label: string,
): void {
  const pagedIds = new Set(ids(paged));
  const bulkIds = new Set(ids(bulk));
  const onlyInPaged = [...pagedIds].filter((id) => !bulkIds.has(id));
  const onlyInBulk = [...bulkIds].filter((id) => !pagedIds.has(id));
  if (onlyInPaged.length > 0 || onlyInBulk.length > 0) {
    throw new Error(
      `${label}: paginated result differs from a single large page ` +
        `(only in paginated: [${onlyInPaged.join(', ')}], only in bulk: [${onlyInBulk.join(', ')}])`,
    );
  }
}

/**
 * Breadth-first walk of `listContainers`, mode-agnostic: works whether the
 * provider is `direct-children` (one BFS step per level) or `flat-subtree`
 * (the first call already returns everything, and re-querying already-known
 * parents is a no-op cost). Returns every container id reachable from
 * `rootParentId`, excluding `rootParentId` itself.
 */
export async function collectContainerIds(
  provider: FileSourceProvider,
  ctx: PluginContext,
  projectId: string,
  rootParentId: string | undefined,
): Promise<Set<string>> {
  const result = new Set<string>();
  const queue: Array<string | undefined> = [rootParentId];
  const visited = new Set<string | undefined>();
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const children = await collectAllPages(
      (request) => provider.listContainers(ctx, projectId, parentId, request),
      100,
    );
    for (const child of children) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      queue.push(child.id);
    }
  }
  return result;
}
