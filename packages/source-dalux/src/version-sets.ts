/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Dalux version sets, and the commit identity derived from them.
//
// A version set is a named, lockable snapshot of a file area: it pins one
// revision of each file. `GET /3.0/projects/{p}/version_sets/{vs}/files`
// returns those pinned `File` rows — each with its own `fileRevisionId`,
// `contentHash`, `lastModified` and author — and
// `GET /2.0/.../files/{f}/revisions/{r}/content` downloads exactly those
// bytes. That is a complete commit history for every file the sets cover,
// which is the only per-file history Dalux exposes at all: there is no
// endpoint that lists a file's revisions.
// ============================================================================

import { DaluxDecodeError } from './dalux-types.js';
import type { DaluxDecoder, DaluxFile } from './dalux-types.js';

export interface DaluxVersionSet {
  readonly versionSetId: string;
  readonly name: string;
  readonly description?: string;
  /** `locked` or `unlocked`. A locked set is one nobody can re-point. */
  readonly status?: string;
  readonly fileAreaId: string;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DaluxDecodeError(`${what}: expected an object, got ${value === null ? 'null' : typeof value}`);
  }
  return value as Record<string, unknown>;
}

function required(source: Record<string, unknown>, field: string, what: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DaluxDecodeError(`${what}.${field}: expected a non-empty string`);
  }
  return value;
}

function optional(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const decodeVersionSet: DaluxDecoder<DaluxVersionSet> = (value) => {
  const source = asRecord(value, 'VersionSet');
  return {
    versionSetId: required(source, 'versionSetId', 'VersionSet'),
    name: required(source, 'name', 'VersionSet'),
    ...(optional(source, 'description') !== undefined ? { description: optional(source, 'description')! } : {}),
    ...(optional(source, 'status') !== undefined ? { status: optional(source, 'status')! } : {}),
    fileAreaId: required(source, 'fileAreaId', 'VersionSet'),
  };
};

// ---------------------------------------------------------------------------
// Commit identity
// ---------------------------------------------------------------------------

/**
 * Digest namespace for Dalux's own `contentHash`.
 *
 * DELIBERATELY NOT `sha256:`. Dalux does not document what algorithm
 * `contentHash` uses, and relabelling it as SHA-256 would be a claim nobody
 * checked — a host would then "verify" a payload against a hash of a
 * different algorithm and either reject good bytes or accept bad ones. The
 * contract allows `<algorithm>:<value>` precisely so a store that exposes
 * only its own hash can be honest about it (`CommitArtifact` in
 * `@ifc-lite/plugin-api`).
 *
 * What this costs, stated plainly: a host cannot independently verify that
 * `loadCommit`'s bytes belong to the commit, and an identity-map sidecar
 * written against `sha256:` cannot pin to a Dalux commit. What it still
 * buys is the property the field actually needs — the value changes when the
 * bytes change, so two versions are always distinguishable.
 */
const CONTENT_DIGEST_PREFIX = 'dalux-content:';

/**
 * Fallback namespace for a file revision Dalux gave no `contentHash` for.
 * `contentHash` is nullable in the schema, and a revision id is still a
 * stable per-revision identity — weaker (it says nothing about the bytes)
 * but never absent, which `artifact.digest` has to be.
 */
const REVISION_DIGEST_PREFIX = 'dalux-revision:';

/** The `<algorithm>:<value>` digest for one pinned revision. */
export function commitDigest(file: Pick<DaluxFile, 'contentHash' | 'fileRevisionId'>): string {
  const hash = file.contentHash?.trim();
  if (hash) return `${CONTENT_DIGEST_PREFIX}${hash}`;
  const revision = file.fileRevisionId?.trim();
  if (revision) return `${REVISION_DIGEST_PREFIX}${revision}`;
  // Unreachable through `collectModelCommits`, which drops a row with no
  // revision id before it gets here — a commit with no identity at all is
  // not a commit. Kept as a total function rather than a throw so a future
  // caller cannot get a silent `undefined`.
  return `${REVISION_DIGEST_PREFIX}unknown`;
}

/**
 * When this revision of the file was last written.
 *
 * `lastModified` first, `uploaded` second. A row with neither still needs a
 * timestamp because `SourceCommit.createdAt` is required and the panel sorts
 * on it — {@link collectModelCommits} supplies the epoch for those and falls
 * back to version-set order, so an undated row sinks to the bottom of the
 * timeline instead of jumping to the top.
 */
export function commitTimestamp(file: Pick<DaluxFile, 'lastModified' | 'uploaded'>): string | undefined {
  return file.lastModified?.trim() || file.uploaded?.trim() || undefined;
}
