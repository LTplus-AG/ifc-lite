/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext, SourceContainer, SourceFile, SourceRevision } from '@ifc-lite/plugin-api';

import {
  decodeFileMetadataStrict,
  decodeMetadataEntry,
} from './dropbox-types.js';
import type { DropboxDecoder, DropboxFileMetadata, DropboxMetadataEntry } from './dropbox-types.js';

/**
 * Internal sentinel meaning "the root of the user's Dropbox" wherever this
 * module builds a `path` argument. Dropbox's own API addresses the root via
 * the literal empty string `""` (its docs are explicit that `"/"` is
 * *rejected* as invalid — root is `""`, and every other path must *not* have
 * a trailing slash) — a value distinct from any real Dropbox `id`, which is
 * always the non-empty `"id:XXXXXXXXXXXX"` form. Safe the same way
 * `source-msgraph`'s `ROOT_CONTAINER_ID` is: chosen to be unambiguous against
 * what the real API actually mints, not a formally proven-impossible
 * collision.
 *
 * Never returned as a `SourceContainer.id` — `listContainers` with no
 * `parentId` returns the root's real child folders directly (each with
 * `parentId: undefined`), matching the plugin contract's "top level" shape.
 */
export const ROOT_CONTAINER_ID = 'root';

/** The `path` argument for a `files/list_folder`/`files/download` call
 *  addressing this container/file id. Dropbox's `path` argument accepts a
 *  `path_lower`, a `path_display`, *or* an opaque `id` interchangeably — this
 *  provider always uses `id` (see `DropboxFileMetadata`'s doc comment for
 *  why), so this function only needs to special-case the root sentinel. */
export function pathArgFor(id: string | undefined): string {
  if (!id || id === ROOT_CONTAINER_ID) return '';
  return id;
}

export function toSourceContainer(entry: Extract<DropboxMetadataEntry, { readonly ['.tag']: 'folder' }>, parentId: string | undefined): SourceContainer {
  return {
    id: entry.id,
    name: entry.name,
    parentId,
    // `files/list_folder` doesn't report a folder's child count inline the
    // way Graph's `folder.childCount` facet does — Dropbox would need a
    // second `list_folder` call to find out, which this provider doesn't
    // spend just to fill in an advisory field. `undefined` ("unknown") is
    // the honest answer per the field's own doc comment in `@ifc-lite/plugin-api`.
    hasChildren: undefined,
    meta: { kind: 'folder' },
  };
}

export function toSourceFile(entry: DropboxFileMetadata, containerId: string): SourceFile {
  return {
    id: entry.id,
    name: entry.name,
    containerId,
    // Dropbox's metadata never reports a MIME type (it isn't a content-typed
    // store the way SharePoint/OneDrive is) — left undefined rather than
    // guessed from the file extension, matching `FileFilter.mimeTypes`'s own
    // "advisory" doc comment about stores that don't report it.
    mimeType: undefined,
    sizeBytes: entry.size,
    // `rev` changes on every content-modifying write and is stable across a
    // metadata-only change (e.g. a rename) — see the doc comment on
    // `DropboxFileMetadata.rev` and the contract `SourceFile.currentRevisionId`
    // documents ("must change when the bytes change and must not change when
    // only metadata changes").
    currentRevisionId: entry.rev,
    modifiedAt: entry.server_modified,
    meta: { contentHash: entry.content_hash },
  };
}

export function toSourceRevision(entry: DropboxFileMetadata): SourceRevision {
  return {
    id: entry.rev,
    label: `Revision ${entry.rev}`,
    createdAt: entry.server_modified ?? new Date(0).toISOString(),
    sizeBytes: entry.size,
  };
}

/**
 * Decodes a raw entry list, dropping (with a logged warning) any record that
 * fails to decode instead of throwing — mirrors `source-msgraph`'s
 * `convertListLenient`: one malformed row in a large listing shouldn't cost
 * the user every other row that decoded fine.
 */
export function convertListLenient<T>(ctx: PluginContext, items: readonly unknown[], decode: DropboxDecoder<T>, typeName: string): T[] {
  const results: T[] = [];
  for (const item of items) {
    try {
      results.push(decode(item));
    } catch (err) {
      ctx.log.warn(`Dropbox: dropping invalid ${typeName} record`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export function decodeMetadataEntries(ctx: PluginContext, items: readonly unknown[]): DropboxMetadataEntry[] {
  return convertListLenient(ctx, items, decodeMetadataEntry, 'metadata entry');
}

export function decodeFileRevisions(ctx: PluginContext, items: readonly unknown[]): DropboxFileMetadata[] {
  return convertListLenient(ctx, items, decodeFileMetadataStrict, 'file revision');
}

/**
 * Derives a `SourceFile.containerId` for a `searchFiles` match, which
 * (unlike `listFiles`, where the caller already supplies the container being
 * queried) can land anywhere in the account and carries no parent-id field
 * in Dropbox's own search response — only `path_lower`. Returns the parent
 * *path* rather than a real Dropbox `id`, which is fine: `pathArgFor` passes
 * an already-id-shaped or already-path-shaped string through unchanged, and
 * Dropbox's `path` argument accepts either form interchangeably, so a host
 * calling `listFiles`/`listContainers` again with this value gets a working
 * query even though it isn't the same *kind* of string `listContainers`
 * itself hands out.
 *
 * Falls back to {@link ROOT_CONTAINER_ID} for a file with no path segments
 * above it (sitting directly at the account root) or, defensively, for the
 * rare match missing `path_lower` entirely — never an empty string, which
 * would otherwise become a `containerId` indistinguishable from "unknown".
 */
export function searchResultContainerId(pathLower: string | undefined): string {
  if (!pathLower) return ROOT_CONTAINER_ID;
  const lastSlash = pathLower.lastIndexOf('/');
  if (lastSlash <= 0) return ROOT_CONTAINER_ID;
  return pathLower.slice(0, lastSlash);
}

const DEFAULT_PAGE_SIZE = 200;
/** Dropbox's own ceiling for `limit` on `files/list_folder` —
 *  `ListFolderArg.limit` in Dropbox's `files.stone` API spec declares
 *  `UInt32(min_value=1, max_value=2000)`. This is *not* the ceiling for
 *  `files/search_v2`, which is lower — see {@link MAX_SEARCH_PAGE_SIZE}. */
const MAX_PAGE_SIZE = 2000;

/** Clamps `ListOptions.limit` ("Hint only; providers clamp to whatever their
 *  API allows" per the contract) to a value `files/list_folder`'s `limit`
 *  argument will accept. */
export function clampPageSize(limit: number | undefined): number {
  const requested = limit && limit > 0 ? Math.floor(limit) : DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(requested, MAX_PAGE_SIZE));
}

const DEFAULT_SEARCH_PAGE_SIZE = 100;
/** Dropbox's own ceiling for `max_results` on `files/search_v2` —
 *  `SearchOptions.max_results` in Dropbox's `files.stone` API spec declares
 *  `UInt64(min_value=1, max_value=1000) = 100`. This is a *different*, lower
 *  ceiling than `list_folder`'s 2000 (`MAX_PAGE_SIZE` above); sending a
 *  `max_results` above 1000 is out of range for this endpoint and the API
 *  answers 400. */
const MAX_SEARCH_PAGE_SIZE = 1000;

/** Clamps `ListOptions.limit` to a value `files/search_v2`'s `max_results`
 *  option will accept — see {@link MAX_SEARCH_PAGE_SIZE}. */
export function clampSearchPageSize(limit: number | undefined): number {
  const requested = limit && limit > 0 ? Math.floor(limit) : DEFAULT_SEARCH_PAGE_SIZE;
  return Math.max(1, Math.min(requested, MAX_SEARCH_PAGE_SIZE));
}

const DEFAULT_REVISIONS_PAGE_SIZE = 10;
/** Dropbox's own ceiling for `limit` on `files/list_revisions` —
 *  `ListRevisionsArg.limit` in Dropbox's `files.stone` API spec documents
 *  `min: 1, max: 100, default: 10`. This is a different, much lower ceiling
 *  than `list_folder`'s 2000 (`MAX_PAGE_SIZE` above); sending `limit` above
 *  100 here is out of range for this endpoint. */
const MAX_REVISIONS_PAGE_SIZE = 100;

/** Clamps `ListOptions.limit` to a value `files/list_revisions`'s `limit`
 *  argument will accept — see {@link MAX_REVISIONS_PAGE_SIZE}. */
export function clampRevisionsPageSize(limit: number | undefined): number {
  const requested = limit && limit > 0 ? Math.floor(limit) : DEFAULT_REVISIONS_PAGE_SIZE;
  return Math.max(1, Math.min(requested, MAX_REVISIONS_PAGE_SIZE));
}
