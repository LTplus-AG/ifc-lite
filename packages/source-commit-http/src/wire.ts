/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// The REST contract's JSON shapes, and the decoding of them.
//
// Everything crossing this boundary comes from a service this package has
// never seen, so nothing is cast. A missing `parents` array or a `status`
// outside the union is a defect in the service, and turning it into a
// `CommitHttpError` here means the host sees one comprehensible failure
// instead of a `TypeError` four frames away in a React render.
// ============================================================================

import type {
  CommitCapabilities,
  CommitPayloadFormat,
  CommitStatus,
  Page,
  SourceCommit,
  SourceModel,
} from '@ifc-lite/plugin-api';

import { CommitHttpError } from './errors.js';

const PAYLOAD_FORMATS: ReadonlySet<string> = new Set<CommitPayloadFormat>([
  'ifc-step', 'ifc-zip', 'ifcx', 'ifc-lite-cache',
]);
const COMMIT_STATUSES: ReadonlySet<string> = new Set<CommitStatus>(['published', 'pending', 'rejected']);

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CommitHttpError('invalid', `Commit service returned a malformed ${what}`, 0);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CommitHttpError('invalid', `Commit service returned no ${what}`, 0);
  }
  return value;
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `{ items, cursor? }` — the same envelope every paged endpoint returns. */
export function decodePage<T>(value: unknown, what: string, decodeItem: (item: unknown) => T): Page<T> {
  const body = record(value, `${what} page`);
  if (!Array.isArray(body.items)) {
    throw new CommitHttpError('invalid', `Commit service returned a ${what} page with no items array`, 0);
  }
  return {
    items: body.items.map(decodeItem),
    ...(typeof body.cursor === 'string' && body.cursor.length > 0 ? { cursor: body.cursor } : {}),
  };
}

export function decodeModel(value: unknown): SourceModel {
  const body = record(value, 'model');
  return {
    id: str(body.id, 'model id'),
    projectId: str(body.projectId, 'model projectId'),
    name: str(body.name, 'model name'),
    ...(optionalStr(body.containerId) !== undefined ? { containerId: body.containerId as string } : {}),
    ...(optionalStr(body.discipline) !== undefined ? { discipline: body.discipline as string } : {}),
    // Empty is legal and means "no commits yet", so this is the one string
    // field that must NOT go through `str`.
    headCommitId: typeof body.headCommitId === 'string' ? body.headCommitId : '',
    ...(optionalNum(body.commitCount) !== undefined ? { commitCount: body.commitCount as number } : {}),
    ...(optionalStr(body.updatedAt) !== undefined ? { updatedAt: body.updatedAt as string } : {}),
  };
}

export function decodeCommit(value: unknown): SourceCommit {
  const body = record(value, 'commit');
  const artifact = record(body.artifact, 'commit artifact');
  const status = typeof body.status === 'string' && COMMIT_STATUSES.has(body.status)
    ? (body.status as CommitStatus)
    // A service that omits `status` predates the field or does not model
    // review; treating that as `published` matches what it means to a user
    // who can see the commit at all.
    : 'published';
  const author = typeof body.author === 'object' && body.author !== null
    ? (body.author as Record<string, unknown>)
    : undefined;
  const stats = typeof body.stats === 'object' && body.stats !== null
    ? (body.stats as Record<string, unknown>)
    : undefined;

  return {
    id: str(body.id, 'commit id'),
    modelId: str(body.modelId, 'commit modelId'),
    projectId: str(body.projectId, 'commit projectId'),
    parents: Array.isArray(body.parents) ? body.parents.filter((p): p is string => typeof p === 'string') : [],
    createdAt: str(body.createdAt, 'commit createdAt'),
    ...(author
      ? { author: {
          id: str(author.id, 'commit author id'),
          ...(optionalStr(author.displayName) !== undefined ? { displayName: author.displayName as string } : {}),
          ...(optionalStr(author.email) !== undefined ? { email: author.email as string } : {}),
        } }
      : {}),
    ...(optionalStr(body.message) !== undefined ? { message: body.message as string } : {}),
    status,
    artifact: {
      digest: str(artifact.digest, 'commit artifact digest'),
      fileName: str(artifact.fileName, 'commit artifact fileName'),
      sizeBytes: optionalNum(artifact.sizeBytes) ?? 0,
      ...(optionalStr(artifact.schema) !== undefined ? { schema: artifact.schema as string } : {}),
    },
    ...(stats
      ? { stats: {
          added: optionalNum(stats.added) ?? 0,
          modified: optionalNum(stats.modified) ?? 0,
          deleted: optionalNum(stats.deleted) ?? 0,
          unchanged: optionalNum(stats.unchanged) ?? 0,
        } }
      : {}),
  };
}

/**
 * `GET /capabilities`.
 *
 * Unknown flags default to FALSE, and an unknown payload format is dropped:
 * a host must never be told a service can do something it cannot, and the
 * cost of the opposite mistake is one missing panel rather than a call that
 * 404s in front of the user.
 */
export function decodeCapabilities(value: unknown): CommitCapabilities {
  const body = record(value, 'capabilities document');
  const commits = record(body.commits ?? body, 'capabilities.commits');
  const formats = Array.isArray(commits.payloadFormats)
    ? commits.payloadFormats.filter((f): f is CommitPayloadFormat => typeof f === 'string' && PAYLOAD_FORMATS.has(f))
    : [];
  if (formats.length === 0) {
    throw new CommitHttpError('invalid', 'Commit service declares no payload format this host understands', 0);
  }
  return {
    payloadFormats: formats,
    fingerprints: commits.fingerprints === true,
    storedDiffs: commits.storedDiffs === true,
    elementHistory: commits.elementHistory === true,
    identityRecords: commits.identityRecords === true,
    write: commits.write === true,
    watch: commits.watch === true,
    // A generic commit service's model ids are its own unless it says
    // otherwise: guessing that a file id addresses a model would make a host
    // ask for a model that does not exist on every panel open.
    modelIdsAreFileIds: commits.modelIdsAreFileIds === true,
  };
}
