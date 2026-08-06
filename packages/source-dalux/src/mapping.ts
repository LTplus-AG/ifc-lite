/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DaluxDecoder, DaluxFile } from './dalux-types.js';
import type { PluginContext, SourceFile } from '@ifc-lite/plugin-api';

/**
 * Sentinel used for `SourceFile.currentRevisionId` (and, symmetrically,
 * `SourceFileRef.revisionId`) when Dalux hasn't given us a real revision id
 * *or* a content hash for a file. `fileRevisionId` is nullable in the
 * schema; the previous mapping faked one with `file.fileId`, which then
 * reached `download()` as if it were a genuine revision id and 404s against
 * `/revisions/{fileId}/content` (a file id, not a revision id). Treating
 * "no revision id" as this explicit, recognizable value instead lets
 * `download()` detect it and fall back to the latest-content path.
 *
 * Deliberately not the plain string "latest": download() reroutes a ref
 * whose revisionId equals this sentinel to the latest-content path rather
 * than fetching a specific revision, so the sentinel must never collide
 * with a real Dalux revision id -- a file legitimately versioned with a
 * label like "latest" would otherwise silently return current bytes for
 * what the caller asked to pin. Observed Dalux revision ids are short
 * opaque alphanumeric/GUID-like tokens, never colon-namespaced strings, so
 * this distinctive namespaced value is a practical mitigation (not a
 * provable guarantee) with no extra moving parts. Bulletproof avoidance
 * would mean tracking "this file genuinely had no revision id" out of band
 * alongside every cached ref -- a bigger change than this warrants today;
 * revisit if Dalux is ever seen minting an id shaped like this one.
 */
export const LATEST_REVISION = 'ifc-lite:dalux:no-revision-id';

/** Separator between a file area id and a folder id in a composite
 * container id. Folder ids need this because `listFiles`/`download` only
 * ever receive a `containerId` string — never the `SourceContainer` object
 * `listContainers` returned it in — so the file area a folder belongs to
 * must be recoverable from the id alone. This is what makes the v1
 * `container-loc:`/`file-loc:` id-to-location cache in `ctx.storage`
 * unnecessary: there is nothing left to look up. */
const CONTAINER_SEP = '::';

/** The container id for a file area itself (no folder component). */
export function fileAreaContainerId(fileAreaId: string): string {
  return fileAreaId;
}

/** The container id for a folder within a file area. */
export function folderContainerId(fileAreaId: string, folderId: string): string {
  return `${fileAreaId}${CONTAINER_SEP}${folderId}`;
}

export interface DecodedContainerId {
  readonly fileAreaId: string;
  readonly folderId?: string;
}

/** Inverse of {@link fileAreaContainerId}/{@link folderContainerId}. A
 * container id with no separator is a bare file area id (folder omitted). */
export function decodeContainerId(containerId: string): DecodedContainerId {
  const sepIndex = containerId.indexOf(CONTAINER_SEP);
  if (sepIndex === -1) return { fileAreaId: containerId };
  return {
    fileAreaId: containerId.slice(0, sepIndex),
    folderId: containerId.slice(sepIndex + CONTAINER_SEP.length),
  };
}

/**
 * The file's current revision identity, per the plugin API contract: "must
 * change when the bytes change and must not change when only metadata
 * changes". Prefers the real `fileRevisionId`; when Dalux gives none, falls
 * back to `contentHash` — which the decoder already captures but which
 * previously went unused — rather than jumping straight to
 * {@link LATEST_REVISION}. A file with no revision id but a real content
 * hash can still change forever; without this fallback `watchRevisions`
 * would compare the sentinel to itself on every poll and never emit.
 *
 * An empty-string `fileRevisionId` (Dalux does send these) is treated the
 * same as an absent one via {@link nonEmptyString}, so it falls through to
 * `contentHash`/the sentinel instead of being cached as `""` — a `""` cache
 * entry fails truthiness checks like `cached &&`, which would otherwise
 * silently swallow the first real event after an empty-string revision id.
 */
export function currentRevisionId(file: Pick<DaluxFile, 'fileRevisionId' | 'contentHash'>): string {
  return nonEmptyString(file.fileRevisionId) ?? nonEmptyString(file.contentHash) ?? LATEST_REVISION;
}

export function toSourceFile(fileAreaId: string, file: DaluxFile): SourceFile {
  const folderId = nonEmptyString(file.folderId);

  return {
    id: file.fileId,
    name: file.fileName,
    // A file's real container is whichever folder it's actually filed under
    // — not the container the caller happened to query — falling back to
    // the file area root only when it has no folder at all.
    containerId: folderId ? folderContainerId(fileAreaId, folderId) : fileAreaContainerId(fileAreaId),
    mimeType: orUndefined(file.fileType),
    sizeBytes: orUndefined(file.fileSize),
    currentRevisionId: currentRevisionId(file),
    modifiedAt: orUndefined(file.lastModified ?? file.uploaded),
    modifiedBy: orUndefined(file.lastModifiedByUserId ?? file.uploadedByUserId),
    meta: { fileAreaId, folderId },
  };
}

export function enc(segment: string): string {
  return encodeURIComponent(segment);
}

export function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

export function nonEmptyString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Unwraps a Dalux `{ data: {...} }` item envelope. Bare objects with no
 * `data` wrapper pass straight through — the API uses both shapes. */
function unwrapDaluxEnvelope(item: unknown): unknown {
  if (item && typeof item === 'object' && !Array.isArray(item) && 'data' in item) {
    return (item as { data: unknown }).data;
  }
  return item;
}

/**
 * Decodes a raw item list, dropping (with a logged warning) any record that
 * fails to decode instead of throwing.
 *
 * For a read-only file catalog, one malformed row — discovered after every
 * page has already been fetched, in some cases after a multi-page sweep —
 * should not cost the user every other row that decoded fine.
 */
export function convertListLenient<T>(
  ctx: PluginContext,
  items: readonly unknown[],
  decode: DaluxDecoder<T>,
  typeName: string,
): T[] {
  const results: T[] = [];
  for (const item of items) {
    try {
      results.push(decode(unwrapDaluxEnvelope(item)));
    } catch (err) {
      ctx.log.warn(`Dalux: dropping invalid ${typeName} record`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
