/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revisions, sign-off and the hash chain (07-interop-versioning-collab.md
 * §2, FR-G06).
 *
 * - A revision is an immutable snapshot `{ revId, parentRevId, label,
 *   author, at, message, contentHash, parentHash, hash }`. `contentHash`
 *   covers the normative content (IDS content without node ids, custom
 *   declarations, test suites); `hash` covers the record and its parent's
 *   hash, so the revisions form a hash chain.
 * - A sign-off `{ revId, by, role, at, statement }` is chained too: its
 *   hash covers the signed revision's hash and the previous sign-off's
 *   hash. It is an attestation, not a qualified electronic signature.
 * - A released revision is read-only: a later revision with different
 *   content on top of it must be a draft (edits branch to a new draft).
 *
 * The log is plain JSON; `verifyRevisionLog` recomputes every hash, so
 * any edit of a stored revision or sign-off is evident.
 */

import { canonicalJson } from '../canonical-json.js';
import type { StudioDocument } from '../document/types.js';
import { uuidv7, type Uuid } from '../uuid.js';
import { sha256Hex } from './sha256.js';

export const REVISION_LOG_FORMAT = 'ifc-lite.ids-studio.revisions';

export type RevisionLabel = 'draft' | 'review' | 'released';

export interface Revision {
  revId: Uuid;
  parentRevId?: Uuid;
  docId: Uuid;
  label: RevisionLabel;
  author: string;
  /** ISO timestamp. */
  at: string;
  message?: string;
  contentHash: string;
  /** `hash` of the parent revision. */
  parentHash?: string;
  hash: string;
  /** The document as committed (restore with `checkoutRevision`). */
  snapshot: StudioDocument;
}

export interface SignOff {
  revId: Uuid;
  by: string;
  role?: string;
  at: string;
  statement: string;
  /** Hash of the signed revision at signing time. */
  revisionHash: string;
  /** Hash of the previous sign-off in the log (empty for the first). */
  prevHash: string;
  hash: string;
}

export interface RevisionLog {
  format: typeof REVISION_LOG_FORMAT;
  docId: Uuid;
  revisions: Revision[];
  signOffs: SignOff[];
}

export class RevisionError extends Error {
  constructor(
    readonly code: 'REV-RELEASED-001' | 'REV-DOC-001' | 'REV-UNKNOWN-001' | 'SIGN-LABEL-001',
    message: string,
  ) {
    super(message);
    this.name = 'RevisionError';
  }
}

/** Hash of the normative content of `doc` (node ids and annotations excluded). */
export function contentHash(doc: StudioDocument): string {
  const ids = {
    ...doc.ids,
    specifications: doc.ids.specifications.map((s) => ({
      ...s,
      id: undefined,
      requirements: s.requirements.map((r) => ({ ...r, id: undefined })),
    })),
  };
  return sha256Hex(canonicalJson({ ids, custom: doc.meta.custom, tests: doc.meta.tests }));
}

export function revisionHash(r: Omit<Revision, 'hash' | 'snapshot'>): string {
  const { revId, parentRevId, docId, label, author, at, message, contentHash: content, parentHash } = r;
  return sha256Hex(canonicalJson({ revId, parentRevId, docId, label, author, at, message, contentHash: content, parentHash }));
}

export function signOffHash(s: Omit<SignOff, 'hash'>): string {
  const { revId, by, role, at, statement, revisionHash: rev, prevHash } = s;
  return sha256Hex(canonicalJson({ revId, by, role, at, statement, revisionHash: rev, prevHash }));
}

export function createRevisionLog(docId: Uuid): RevisionLog {
  return { format: REVISION_LOG_FORMAT, docId, revisions: [], signOffs: [] };
}

export function headRevision(log: RevisionLog): Revision | undefined {
  return log.revisions[log.revisions.length - 1];
}

export function findRevision(log: RevisionLog, revId: Uuid): Revision | undefined {
  return log.revisions.find((r) => r.revId === revId);
}

export interface CommitRevisionInfo {
  author: string;
  at?: string;
  message?: string;
  label?: RevisionLabel;
  /** Defaults to the head revision. */
  parentRevId?: Uuid;
  revId?: Uuid;
}

/** Record `doc` as a new revision. Returns the new log (the input is not changed). */
export function commitRevision(log: RevisionLog, doc: StudioDocument, info: CommitRevisionInfo): { log: RevisionLog; revision: Revision } {
  if (doc.docId !== log.docId) throw new RevisionError('REV-DOC-001', `document ${doc.docId} does not belong to this log (${log.docId})`);
  const parent = info.parentRevId !== undefined ? findRevision(log, info.parentRevId) : headRevision(log);
  if (info.parentRevId !== undefined && !parent) throw new RevisionError('REV-UNKNOWN-001', `unknown parent revision ${info.parentRevId}`);
  const label = info.label ?? 'draft';
  const content = contentHash(doc);
  if (parent?.label === 'released' && parent.contentHash !== content && label !== 'draft') {
    throw new RevisionError('REV-RELEASED-001', 'a released revision is read-only: edits on top of it start a new draft');
  }
  const record: Omit<Revision, 'hash' | 'snapshot'> = {
    revId: info.revId ?? uuidv7(),
    docId: log.docId,
    label,
    author: info.author,
    at: info.at ?? new Date().toISOString(),
    contentHash: content,
    ...(parent ? { parentRevId: parent.revId, parentHash: parent.hash } : {}),
    ...(info.message !== undefined ? { message: info.message } : {}),
  };
  const revision: Revision = { ...record, hash: revisionHash(record), snapshot: doc };
  return { log: { ...log, revisions: [...log.revisions, revision] }, revision };
}

export interface SignOffInfo {
  by: string;
  role?: string;
  at?: string;
  statement: string;
}

/** Attest a revision in review or released. */
export function signOff(log: RevisionLog, revId: Uuid, info: SignOffInfo): { log: RevisionLog; signOff: SignOff } {
  const revision = findRevision(log, revId);
  if (!revision) throw new RevisionError('REV-UNKNOWN-001', `unknown revision ${revId}`);
  if (revision.label === 'draft') throw new RevisionError('SIGN-LABEL-001', 'only a revision in review or released can be signed off');
  const prev = log.signOffs[log.signOffs.length - 1];
  const record: Omit<SignOff, 'hash'> = {
    revId,
    by: info.by,
    at: info.at ?? new Date().toISOString(),
    statement: info.statement,
    revisionHash: revision.hash,
    prevHash: prev?.hash ?? '',
    ...(info.role !== undefined ? { role: info.role } : {}),
  };
  const entry: SignOff = { ...record, hash: signOffHash(record) };
  return { log: { ...log, signOffs: [...log.signOffs, entry] }, signOff: entry };
}

/** The committed document of a revision (to view it, or to branch a draft from it). */
export function checkoutRevision(log: RevisionLog, revId: Uuid): StudioDocument {
  const revision = findRevision(log, revId);
  if (!revision) throw new RevisionError('REV-UNKNOWN-001', `unknown revision ${revId}`);
  return revision.snapshot;
}

/** True when `doc` may not be edited in place: its content is a released revision's. */
export function isReleasedContent(log: RevisionLog, doc: StudioDocument): boolean {
  const content = contentHash(doc);
  return log.revisions.some((r) => r.label === 'released' && r.contentHash === content);
}
