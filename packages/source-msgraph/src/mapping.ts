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

/**
 * Note what is deliberately *not* carried over: the item's
 * `@microsoft.graph.downloadUrl`. That URL is pre-authenticated — holding it
 * is enough to download the bytes, with no credential and no header, which is
 * exactly why `download()` fetches it through `ctx.fetchPublic`. `SourceFile`
 * is a value the host treats as opaque and persists whole: the viewer
 * serialises entire `SourceFile[]` arrays into `localStorage` for its catalog
 * cache. Putting a credential-equivalent value in a field designed to be
 * persisted is the wrong shape regardless of whether a given provider's
 * capabilities currently reach that code path, and `download()` re-fetches the
 * URL fresh anyway (these URLs are short-lived, so a cached one would be
 * useless as well as unsafe).
 */
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
  };
}

/**
 * Two id spaces, deliberately not reconciled.
 *
 * `SourceFile.currentRevisionId` is the item's `cTag` (see
 * {@link currentRevisionId}) — the only Graph field that satisfies the plugin
 * contract's "changes when the bytes change, not when metadata changes". A
 * `driveItemVersion.id`, in contrast, is a SharePoint version *label* (`"1.0"`,
 * `"2.0"`), which is what `SourceRevision.id` is documented to be ("SharePoint
 * version labels are `"1.0"` and `"2.0"`, not integers"). Graph offers no field
 * that is both, and no way to map one to the other without an extra request
 * per version.
 *
 * The visible consequence: a `SourceFileRef.revisionId` naming the newest
 * *listed* revision (`"2.0"`) will not equal the item's `currentRevisionId`
 * (`cTag`), so `download()` rejects it as historical even though it names the
 * current bytes. That is a documented no-op rather than a bug, because
 * `capabilities.downloadHistoricalRevisions` is `false`, and the contract on
 * that flag says "Hosts must not offer 'load this older revision' when this is
 * false" — the only `revisionId` a host may hand back is the one this provider
 * gave it on the `SourceFile`, which is the cTag and matches. Reconciling the
 * spaces would mean paying a request per listed version to buy nothing that
 * any caller is allowed to use; if `downloadHistoricalRevisions` ever becomes
 * `true`, this is the thing to fix first.
 */
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
 *  API allows" per the contract) to a value Graph's `$top` will accept.
 *  Floors at 1 — a fractional `limit` between 0 and 1 (e.g. `0.5`) survives
 *  the `limit > 0` guard above but floors to `0`, which would send Graph a
 *  literal `$top=0` rather than "at least one item". Mirrors
 *  `source-dropbox`'s `clampPageSize`, which floors the same way. */
export function clampPageSize(limit: number | undefined): string {
  const requested = limit && limit > 0 ? Math.floor(limit) : DEFAULT_PAGE_SIZE;
  return String(Math.max(1, Math.min(requested, MAX_PAGE_SIZE)));
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
