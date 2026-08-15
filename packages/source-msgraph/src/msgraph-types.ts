/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Hand-written decoders for the slice of Microsoft Graph's driveItem/drive
// shapes this provider reads. Reject wrong-typed fields rather than coerce
// them — a decode failure drops that one row (see `convertListLenient` in
// `mapping.ts`) instead of corrupting a listing with guessed data.
// ============================================================================

export interface GraphFolderFacet {
  readonly childCount?: number;
}

export interface GraphFileFacet {
  readonly mimeType?: string;
}

export interface GraphDeletedFacet {
  readonly state?: string;
}

export interface GraphIdentity {
  readonly id?: string;
  readonly displayName?: string;
}

export interface GraphIdentitySet {
  readonly user?: GraphIdentity;
  readonly application?: GraphIdentity;
}

export interface GraphDriveItem {
  readonly id: string;
  readonly name: string;
  readonly size?: number;
  readonly cTag?: string;
  readonly eTag?: string;
  readonly lastModifiedDateTime?: string;
  readonly lastModifiedBy?: GraphIdentitySet;
  readonly folder?: GraphFolderFacet;
  readonly file?: GraphFileFacet;
  readonly deleted?: GraphDeletedFacet;
  readonly parentReference?: { readonly id?: string };
  readonly ['@microsoft.graph.downloadUrl']?: string;
}

export interface GraphDriveItemVersion {
  readonly id: string;
  readonly size?: number;
  readonly lastModifiedDateTime?: string;
  readonly lastModifiedBy?: GraphIdentitySet;
}

export interface GraphDrive {
  readonly id: string;
  readonly name?: string;
  readonly driveType?: string;
  readonly owner?: GraphIdentitySet;
}

/** `{ value: T[], '@odata.nextLink'?: string }` — every Graph collection response. */
export interface GraphCollectionPage<T> {
  readonly value: readonly T[];
  readonly ['@odata.nextLink']?: string;
  /** Present on `/delta` responses once the feed has caught up. */
  readonly ['@odata.deltaLink']?: string;
}

export type GraphDecoder<T> = (raw: unknown) => T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Graph ${context}: field "${key}" is missing or not a non-empty string`);
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

function optionalIdentitySet(record: Record<string, unknown>, key: string): GraphIdentitySet | undefined {
  const value = record[key];
  if (!isRecord(value)) return undefined;
  const user = isRecord(value.user)
    ? { id: optionalString(value.user, 'id'), displayName: optionalString(value.user, 'displayName') }
    : undefined;
  const application = isRecord(value.application)
    ? {
        id: optionalString(value.application, 'id'),
        displayName: optionalString(value.application, 'displayName'),
      }
    : undefined;
  return { user, application };
}

export function decodeDriveItem(raw: unknown): GraphDriveItem {
  if (!isRecord(raw)) throw new Error('Graph driveItem: not an object');
  const id = requireString(raw, 'id', 'driveItem');
  const name = requireString(raw, 'name', 'driveItem');

  const folder = isRecord(raw.folder) ? { childCount: optionalNumber(raw.folder, 'childCount') } : undefined;
  const file = isRecord(raw.file) ? { mimeType: optionalString(raw.file, 'mimeType') } : undefined;
  const deleted = isRecord(raw.deleted) ? { state: optionalString(raw.deleted, 'state') } : undefined;
  const parentReference = isRecord(raw.parentReference)
    ? { id: optionalString(raw.parentReference, 'id') }
    : undefined;

  return {
    id,
    name,
    size: optionalNumber(raw, 'size'),
    cTag: optionalString(raw, 'cTag'),
    eTag: optionalString(raw, 'eTag'),
    lastModifiedDateTime: optionalString(raw, 'lastModifiedDateTime'),
    lastModifiedBy: optionalIdentitySet(raw, 'lastModifiedBy'),
    folder,
    file,
    deleted,
    parentReference,
    '@microsoft.graph.downloadUrl': optionalString(raw, '@microsoft.graph.downloadUrl'),
  };
}

export function decodeDriveItemVersion(raw: unknown): GraphDriveItemVersion {
  if (!isRecord(raw)) throw new Error('Graph driveItemVersion: not an object');
  const id = requireString(raw, 'id', 'driveItemVersion');
  return {
    id,
    size: optionalNumber(raw, 'size'),
    lastModifiedDateTime: optionalString(raw, 'lastModifiedDateTime'),
    lastModifiedBy: optionalIdentitySet(raw, 'lastModifiedBy'),
  };
}

export function decodeDrive(raw: unknown): GraphDrive {
  if (!isRecord(raw)) throw new Error('Graph drive: not an object');
  const id = requireString(raw, 'id', 'drive');
  return {
    id,
    name: optionalString(raw, 'name'),
    driveType: optionalString(raw, 'driveType'),
    owner: optionalIdentitySet(raw, 'owner'),
  };
}

/** Normalizes a Graph collection response body, tolerating a body that failed
 * to parse as the expected shape (treated as an empty page rather than a hard
 * throw — a malformed *page* is a provider-detectable error via the
 * individual item decoders below, not this envelope). */
export function decodeCollectionPage(raw: unknown): { items: readonly unknown[]; nextLink?: string; deltaLink?: string } {
  if (!isRecord(raw)) return { items: [] };
  const value = Array.isArray(raw.value) ? raw.value : [];
  return {
    items: value,
    nextLink: optionalString(raw, '@odata.nextLink'),
    deltaLink: optionalString(raw, '@odata.deltaLink'),
  };
}
