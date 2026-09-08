/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Response shapes for the Dalux Build API, and hand-written decoders for them.
 *
 * This package previously borrowed types and zod schemas from a third-party
 * `dalux-build-api` client by deep-importing its `src/` internals. That is
 * gone: deep-importing another package's internals breaks on any upstream
 * reorganisation, it made a published `@ifc-lite/*` package depend on a
 * single-maintainer package, and it dragged zod into the viewer's eagerly
 * loaded bundle for what amounts to a few dozen field checks. The sibling
 * SharePoint/OneDrive provider talks to Microsoft Graph with nothing but
 * `fetch` and hand-written narrowing; there is no reason this one needs more.
 *
 * The decoders below reproduce the previous schemas' semantics as closely as
 * possible, so this is mostly a dependency change and not a behaviour
 * change:
 *
 *   - Unknown keys are ignored (zod objects are non-strict by default).
 *   - `nullish()` fields accept a missing key *or* an explicit `null`, and
 *     both normalise to `undefined`.
 *   - A present field of the wrong type is a decode failure rather than
 *     something to coerce, because silently reinterpreting `fileSize: "big"`
 *     as a number would be worse than dropping the row. The one deliberate
 *     exception is a non-*finite* number (`NaN`/`Infinity`, e.g. from a
 *     `fileSize: 1e999` payload): zod's `z.number()` accepted those, so
 *     rejecting them outright would be a real behaviour change hiding in
 *     this refactor. See {@link optionalNumber}.
 *   - `deleted` mirrors the old `nullableDefault(z.boolean(), false)`:
 *     absent or null becomes `false`, but a non-boolean is rejected.
 *
 * Decoders throw {@link DaluxDecodeError} naming the offending field. List
 * call sites drop the individual row and warn (see `convertListLenient`);
 * single-item lookups let it propagate, which is the right asymmetry for a
 * read-only catalog: one bad row among thousands should not cost the user the
 * other rows, but a malformed response to a specific file lookup should fail
 * loudly rather than silently behave as "no download link".
 */

export class DaluxDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaluxDecodeError';
  }
}

export interface DaluxProject {
  readonly projectId: string;
  readonly projectName: string;
}

export interface DaluxFileArea {
  readonly fileAreaId: string;
  readonly fileAreaName: string;
  readonly fileAreaType: string;
}

export interface DaluxFolder {
  readonly folderId: string;
  readonly folderName: string;
  readonly parentFolderId?: string;
}

export interface DaluxFile {
  readonly fileId: string;
  readonly fileRevisionId?: string;
  readonly fileName: string;
  readonly fileAreaId: string;
  readonly folderId?: string;
  readonly uploadedByUserId?: string;
  readonly uploaded?: string;
  readonly lastModifiedByUserId?: string;
  readonly lastModified?: string;
  readonly version?: string;
  readonly deleted: boolean;
  readonly fileType?: string;
  readonly fileSize?: number;
  readonly contentHash?: string;
  readonly downloadLink?: string;
}

export interface DaluxFileResponse {
  readonly data: DaluxFile;
}

/** A decoder turns an unknown payload into `T` or throws {@link DaluxDecodeError}. */
export type DaluxDecoder<T> = (value: unknown) => T;

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`${what}: expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new DaluxDecodeError(message);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/** Required string. Empty strings are allowed — Dalux does return them, and an
 *  id or name we cannot use is caught downstream, not here. */
function requiredString(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    return fail(`${what}.${key}: expected a string, got ${describe(value)}`);
  }
  return value;
}

/** `z.string().nullish()` — absent or null becomes `undefined`. */
function optionalString(
  source: Record<string, unknown>,
  key: string,
  what: string,
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    return fail(`${what}.${key}: expected a string or null, got ${describe(value)}`);
  }
  return value;
}

/**
 * `z.number().nullish()`. Deliberate, documented deviation from "reproduce
 * the old zod semantics exactly": zod's `z.number()` *accepts* NaN and
 * Infinity, so a response like `fileSize: 1e999` (JSON-parses to `Infinity`)
 * decoded fine before this decoder replaced it. Rejecting non-finite values
 * outright — as an earlier version of this decoder did — silently changed
 * that: it turned `convertListLenient` into dropping the *entire file* from
 * the listing over one bad numeric field, which is a worse outcome for a
 * read-only catalog than just losing that field. So a non-finite number
 * coerces to `undefined` (the row survives, `fileSize` just isn't reported)
 * instead of failing the decode.
 */
function optionalNumber(
  source: Record<string, unknown>,
  key: string,
  what: string,
): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') {
    return fail(`${what}.${key}: expected a number or null, got ${describe(value)}`);
  }
  return Number.isFinite(value) ? value : undefined;
}

/** `nullableDefault(z.boolean(), false)` — absent or null becomes the default. */
function booleanWithDefault(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  what: string,
): boolean {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    return fail(`${what}.${key}: expected a boolean or null, got ${describe(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

export const decodeProject: DaluxDecoder<DaluxProject> = (value) => {
  const source = asRecord(value, 'Project');
  return {
    projectId: requiredString(source, 'projectId', 'Project'),
    projectName: requiredString(source, 'projectName', 'Project'),
  };
};

export const decodeFileArea: DaluxDecoder<DaluxFileArea> = (value) => {
  const source = asRecord(value, 'FileArea');
  return {
    fileAreaId: requiredString(source, 'fileAreaId', 'FileArea'),
    fileAreaName: requiredString(source, 'fileAreaName', 'FileArea'),
    fileAreaType: requiredString(source, 'fileAreaType', 'FileArea'),
  };
};

export const decodeFolder: DaluxDecoder<DaluxFolder> = (value) => {
  const source = asRecord(value, 'Folder');
  return {
    folderId: requiredString(source, 'folderId', 'Folder'),
    folderName: requiredString(source, 'folderName', 'Folder'),
    parentFolderId: optionalString(source, 'parentFolderId', 'Folder'),
  };
};

export const decodeFile: DaluxDecoder<DaluxFile> = (value) => {
  const source = asRecord(value, 'File');
  return {
    fileId: requiredString(source, 'fileId', 'File'),
    fileRevisionId: optionalString(source, 'fileRevisionId', 'File'),
    fileName: requiredString(source, 'fileName', 'File'),
    fileAreaId: requiredString(source, 'fileAreaId', 'File'),
    folderId: optionalString(source, 'folderId', 'File'),
    uploadedByUserId: optionalString(source, 'uploadedByUserId', 'File'),
    uploaded: optionalString(source, 'uploaded', 'File'),
    lastModifiedByUserId: optionalString(source, 'lastModifiedByUserId', 'File'),
    lastModified: optionalString(source, 'lastModified', 'File'),
    version: optionalString(source, 'version', 'File'),
    deleted: booleanWithDefault(source, 'deleted', false, 'File'),
    fileType: optionalString(source, 'fileType', 'File'),
    fileSize: optionalNumber(source, 'fileSize', 'File'),
    contentHash: optionalString(source, 'contentHash', 'File'),
    downloadLink: optionalString(source, 'downloadLink', 'File'),
  };
};

/**
 * `{ data: File, links?: [...] }` single-item envelope. Unlike the list
 * decoders this is used where a failure should be loud, so it throws.
 */
export const decodeFileResponse: DaluxDecoder<DaluxFileResponse> = (value) => {
  const source = asRecord(value, 'FileResponse');
  if (!('data' in source)) {
    return fail('FileResponse.data: missing');
  }
  return { data: decodeFile(source.data) };
};
