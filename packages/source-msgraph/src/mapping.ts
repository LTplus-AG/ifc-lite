/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext, SourceContainer, SourceFile, SourceRevision } from '@ifc-lite/plugin-api';

import { decodeDriveItem, decodeDriveItemVersion } from './msgraph-types.js';
import type { GraphDecoder, GraphDriveItem, GraphDriveItemVersion } from './msgraph-types.js';

/**
 * Internal sentinel meaning "the drive root" wherever this module builds a
 * Graph URL. Graph addresses the root via the well-known path segment `root`
 * (`/me/drive/root`, `/me/drive/root/children`), which is distinct from any
 * real `driveItem.id` — those are opaque, non-numeric tokens Graph mints
 * (e.g. `01BYE5RZ...`) and never the bare string `"root"` — so this is safe
 * the same way `source-dalux`'s `LATEST_REVISION` is: a value chosen to be
 * unambiguous against what the real API actually mints, not a formally
 * proven-impossible collision.
 *
 * Never returned as a `SourceContainer.id` — `listContainers` with no
 * `parentId` returns the drive root's real child folders directly (each with
 * `parentId: undefined`), matching the plugin contract's "top level" shape
 * exactly rather than wrapping it in a synthetic container. One consequence,
 * documented in the package README: a file sitting directly at the drive
 * root (not inside any folder) has no `SourceContainer` to be addressed
 * through and is not currently listed by this provider.
 */
export const ROOT_CONTAINER_ID = 'root';

/** The `/children` (or `/search`) endpoint path for a given container id. */
export function childrenEndpoint(containerId: string | undefined): string {
  if (!containerId || containerId === ROOT_CONTAINER_ID) return '/me/drive/root/children';
  return `/me/drive/items/${enc(containerId)}/children`;
}

export function enc(segment: string): string {
  return encodeURIComponent(segment);
}

export function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/**
 * The item's current revision identity, per the plugin API contract: "must
 * change when the bytes change and must not change when only metadata
 * changes." `cTag` ("content tag") is Graph's own field for exactly that
 * distinction — it changes only when the file's content changes, unlike
 * `eTag`, which also changes on a rename or a metadata-only edit. Falls back
 * to `eTag`, then to the item id itself, for the rare item missing `cTag`
 * (folders don't have one; this function is only ever called on files).
 */
export function currentRevisionId(item: Pick<GraphDriveItem, 'id' | 'cTag' | 'eTag'>): string {
  return item.cTag ?? item.eTag ?? item.id;
}

export function toSourceContainer(item: GraphDriveItem, parentId: string | undefined): SourceContainer {
  return {
    id: item.id,
    name: item.name,
    parentId,
    hasChildren: item.folder?.childCount !== undefined ? item.folder.childCount > 0 : undefined,
    meta: { kind: 'folder' },
  };
}

export function toSourceFile(item: GraphDriveItem, containerId: string): SourceFile {
  return {
    id: item.id,
    name: item.name,
    containerId,
    mimeType: item.file?.mimeType,
    sizeBytes: item.size,
    currentRevisionId: currentRevisionId(item),
    modifiedAt: item.lastModifiedDateTime,
    modifiedBy: item.lastModifiedBy?.user?.displayName ?? item.lastModifiedBy?.application?.displayName,
    meta: { downloadUrl: item['@microsoft.graph.downloadUrl'] },
  };
}

export function toSourceRevision(version: GraphDriveItemVersion): SourceRevision {
  return {
    id: version.id,
    label: `Version ${version.id}`,
    createdAt: version.lastModifiedDateTime ?? new Date(0).toISOString(),
    createdBy: version.lastModifiedBy?.user?.displayName ?? version.lastModifiedBy?.application?.displayName,
    sizeBytes: version.size,
  };
}

/**
 * Decodes a raw item list, dropping (with a logged warning) any record that
 * fails to decode instead of throwing — mirrors `source-dalux`'s
 * `convertListLenient`: one malformed row in a large drive listing
 * shouldn't cost the user every other row that decoded fine.
 */
export function convertListLenient<T>(ctx: PluginContext, items: readonly unknown[], decode: GraphDecoder<T>, typeName: string): T[] {
  const results: T[] = [];
  for (const item of items) {
    try {
      results.push(decode(item));
    } catch (err) {
      ctx.log.warn(`Microsoft Graph: dropping invalid ${typeName} record`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export function decodeDriveItems(ctx: PluginContext, items: readonly unknown[]): GraphDriveItem[] {
  return convertListLenient(ctx, items, decodeDriveItem, 'driveItem');
}

export function decodeDriveItemVersions(ctx: PluginContext, items: readonly unknown[]): GraphDriveItemVersion[] {
  return convertListLenient(ctx, items, decodeDriveItemVersion, 'driveItemVersion');
}

const DEFAULT_PAGE_SIZE = 200;
/** Graph's own ceiling for `$top` on driveItem collections. */
const MAX_PAGE_SIZE = 999;

/** Clamps `ListOptions.limit` ("Hint only; providers clamp to whatever their
 *  API allows" per the contract) to a value Graph's `$top` will accept. */
export function clampPageSize(limit: number | undefined): string {
  const requested = limit && limit > 0 ? Math.floor(limit) : DEFAULT_PAGE_SIZE;
  return String(Math.min(requested, MAX_PAGE_SIZE));
}

/**
 * Builds the path for Graph's `search(q='...')` function on the drive root.
 * The query text is embedded in the URL path itself (not a query-string
 * parameter), inside a single-quoted OData string literal — so a literal
 * single quote in the user's search text must be escaped by doubling it
 * (OData string-literal escaping, the same rule SQL uses), not by percent-
 * encoding, or Graph would see an early close of the literal and reject the
 * request as malformed rather than searching for the user's actual text.
 * `encodeURIComponent` runs after that doubling and leaves `'` untouched (it
 * is not one of the characters `encodeURIComponent` escapes), so the escaped
 * quotes survive into the final URL exactly as OData expects them.
 */
export function searchEndpoint(query: string): string {
  const escaped = query.replace(/'/g, "''");
  return `/me/drive/root/search(q='${encodeURIComponent(escaped)}')`;
}
