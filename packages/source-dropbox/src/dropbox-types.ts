/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Hand-written decoders for the slice of the Dropbox API's metadata shapes
// this provider reads. Reject wrong-typed fields rather than coerce them — a
// decode failure drops that one row (see `convertListLenient` in `mapping.ts`)
// instead of corrupting a listing with guessed data. Mirrors
// `source-msgraph`'s `msgraph-types.ts`.
// ============================================================================

/** Dropbox's own opaque, namespace-stable identifier — `"id:XXXXXXXXXXXX"`
 *  for a file, `"id:YYYYYYYYYYYY"` for a folder. Accepted anywhere the API
 *  takes a `path` argument, so this provider addresses everything by `id`
 *  rather than by `path_lower`/`path_display`: an id survives a rename or
 *  move, a path does not. */
export interface DropboxFileMetadata {
  readonly ['.tag']: 'file';
  readonly id: string;
  readonly name: string;
  readonly path_lower?: string;
  readonly size?: number;
  readonly rev: string;
  readonly client_modified?: string;
  readonly server_modified?: string;
  readonly content_hash?: string;
}

export interface DropboxFolderMetadata {
  readonly ['.tag']: 'folder';
  readonly id: string;
  readonly name: string;
  readonly path_lower?: string;
}

export interface DropboxDeletedMetadata {
  readonly ['.tag']: 'deleted';
  readonly id?: string;
  readonly name: string;
  readonly path_lower?: string;
}

export type DropboxMetadataEntry = DropboxFileMetadata | DropboxFolderMetadata | DropboxDeletedMetadata;

export interface DropboxListFolderResult {
  readonly entries: readonly unknown[];
  readonly cursor: string;
  readonly has_more: boolean;
}

export interface DropboxListRevisionsResult {
  readonly is_deleted: boolean;
  readonly entries: readonly unknown[];
  /** Dropbox's own continuation flag: "If true, then there are more entries
   *  available. Call list_revisions again with before_rev equal to the
   *  revision of the last returned entry to retrieve the rest." (Dropbox's
   *  `files.stone` API spec, `ListRevisionsResult.has_more`). */
  readonly has_more: boolean;
}

export interface DropboxSearchMatch {
  readonly metadata: DropboxFileMetadata | DropboxFolderMetadata;
}

export interface DropboxSearchResult {
  readonly matches: readonly DropboxSearchMatch[];
  readonly has_more: boolean;
  readonly cursor?: string;
}

export interface DropboxCurrentAccount {
  readonly account_id: string;
  readonly displayName?: string;
  readonly email?: string;
}

export type DropboxDecoder<T> = (raw: unknown) => T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Dropbox ${context}: field "${key}" is missing or not a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

export function decodeMetadataEntry(raw: unknown): DropboxMetadataEntry {
  if (!isRecord(raw)) throw new Error('Dropbox metadata: not an object');
  const tag = raw['.tag'];
  const name = requireString(raw, 'name', 'metadata');
  const path_lower = optionalString(raw, 'path_lower');

  if (tag === 'folder') {
    return { '.tag': 'folder', id: requireString(raw, 'id', 'folder metadata'), name, path_lower };
  }
  if (tag === 'deleted') {
    return { '.tag': 'deleted', id: optionalString(raw, 'id'), name, path_lower };
  }
  if (tag === 'file') {
    return decodeFileMetadata(raw, name, path_lower);
  }
  throw new Error(`Dropbox metadata: unrecognized ".tag" (${JSON.stringify(tag)})`);
}

function decodeFileMetadata(
  raw: Record<string, unknown>,
  name: string,
  path_lower: string | undefined,
): DropboxFileMetadata {
  return {
    '.tag': 'file',
    id: requireString(raw, 'id', 'file metadata'),
    name,
    path_lower,
    size: optionalNumber(raw, 'size'),
    rev: requireString(raw, 'rev', 'file metadata'),
    client_modified: optionalString(raw, 'client_modified'),
    server_modified: optionalString(raw, 'server_modified'),
    content_hash: optionalString(raw, 'content_hash'),
  };
}

/** Same shape as {@link decodeMetadataEntry}'s `'file'` branch, but for a
 *  `files/list_revisions` entry, which is documented to always be a
 *  `FileMetadata` (never a folder or a deleted marker). */
export function decodeFileMetadataStrict(raw: unknown): DropboxFileMetadata {
  if (!isRecord(raw)) throw new Error('Dropbox file metadata: not an object');
  const name = requireString(raw, 'name', 'file metadata');
  return decodeFileMetadata(raw, name, optionalString(raw, 'path_lower'));
}

export function decodeListFolderResult(raw: unknown): DropboxListFolderResult {
  if (!isRecord(raw)) throw new Error('Dropbox list_folder result: not an object');
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return {
    entries,
    cursor: requireString(raw, 'cursor', 'list_folder result'),
    has_more: raw.has_more === true,
  };
}

export function decodeListRevisionsResult(raw: unknown): DropboxListRevisionsResult {
  if (!isRecord(raw)) throw new Error('Dropbox list_revisions result: not an object');
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return { is_deleted: raw.is_deleted === true, entries, has_more: raw.has_more === true };
}

export function decodeSearchResult(raw: unknown): DropboxSearchResult {
  if (!isRecord(raw)) throw new Error('Dropbox search_v2 result: not an object');
  const rawMatches = Array.isArray(raw.matches) ? raw.matches : [];
  const matches: DropboxSearchMatch[] = [];
  for (const rawMatch of rawMatches) {
    if (!isRecord(rawMatch) || !isRecord(rawMatch.metadata)) continue;
    const decoded = decodeMetadataEntry(rawMatch.metadata);
    if (decoded['.tag'] === 'deleted') continue; // search never returns deleted entries; skip defensively
    matches.push({ metadata: decoded });
  }
  return { matches, has_more: raw.has_more === true, cursor: optionalString(raw, 'cursor') };
}

export function decodeCurrentAccount(raw: unknown): DropboxCurrentAccount {
  if (!isRecord(raw)) throw new Error('Dropbox get_current_account result: not an object');
  const accountId = requireString(raw, 'account_id', 'current account');
  const name = isRecord(raw.name) ? optionalString(raw.name, 'display_name') : undefined;
  return { account_id: accountId, displayName: name, email: optionalString(raw, 'email') };
}
