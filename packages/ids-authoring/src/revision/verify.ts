/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tamper evidence for a revision log: every hash is recomputed and every
 * link checked. Problems are data (`code`, `revId`, `message`), so a UI can
 * mark the affected revisions and a CLI can fail.
 */

import type { Uuid } from '../uuid.js';
import { contentHash, REVISION_LOG_FORMAT, revisionHash, signOffHash, type RevisionLog } from './revision.js';

export type RevisionProblemCode =
  | 'REV-FORMAT-001'
  | 'REV-DOC-001'
  | 'REV-DUP-001'
  | 'REV-HASH-001'
  | 'REV-CONTENT-001'
  | 'REV-CHAIN-001'
  | 'REV-RELEASED-001'
  | 'SIGN-REV-001'
  | 'SIGN-HASH-001'
  | 'SIGN-CHAIN-001';

export interface RevisionProblem {
  code: RevisionProblemCode;
  message: string;
  revId?: Uuid;
  /** Index of the sign-off, for SIGN-* problems. */
  signOff?: number;
}

export interface RevisionVerification {
  ok: boolean;
  problems: RevisionProblem[];
}

export function verifyRevisionLog(log: RevisionLog): RevisionVerification {
  const problems: RevisionProblem[] = [];
  if (log.format !== REVISION_LOG_FORMAT) problems.push({ code: 'REV-FORMAT-001', message: 'not an IDS Studio revision log' });
  const byId = new Map<Uuid, RevisionLog['revisions'][number]>();
  for (const r of log.revisions) {
    if (byId.has(r.revId)) problems.push({ code: 'REV-DUP-001', revId: r.revId, message: 'revision id appears twice' });
    byId.set(r.revId, r);
  }
  log.revisions.forEach((r, i) => {
    const at = { revId: r.revId };
    if (r.docId !== log.docId || r.snapshot.docId !== log.docId) problems.push({ ...at, code: 'REV-DOC-001', message: 'revision belongs to another document' });
    if (revisionHash(r) !== r.hash) problems.push({ ...at, code: 'REV-HASH-001', message: 'revision record does not match its hash' });
    if (contentHash(r.snapshot) !== r.contentHash) problems.push({ ...at, code: 'REV-CONTENT-001', message: 'revision content does not match its content hash' });
    if (r.parentRevId === undefined) {
      if (i > 0 || r.parentHash !== undefined) problems.push({ ...at, code: 'REV-CHAIN-001', message: 'only the first revision may have no parent' });
      return;
    }
    const parent = byId.get(r.parentRevId);
    const parentIndex = log.revisions.findIndex((x) => x.revId === r.parentRevId);
    if (!parent || parentIndex >= i || parent.hash !== r.parentHash) {
      problems.push({ ...at, code: 'REV-CHAIN-001', message: 'parent revision is missing, later, or does not match the recorded parent hash' });
      return;
    }
    if (parent.label === 'released' && parent.contentHash !== r.contentHash && r.label !== 'draft') {
      problems.push({ ...at, code: 'REV-RELEASED-001', message: 'a released revision was edited without starting a new draft' });
    }
  });
  log.signOffs.forEach((s, i) => {
    const at = { revId: s.revId, signOff: i };
    const revision = byId.get(s.revId);
    if (!revision || revision.hash !== s.revisionHash) problems.push({ ...at, code: 'SIGN-REV-001', message: 'signed revision is missing or changed since it was signed' });
    if (signOffHash(s) !== s.hash) problems.push({ ...at, code: 'SIGN-HASH-001', message: 'sign-off record does not match its hash' });
    const prev = i > 0 ? log.signOffs[i - 1].hash : '';
    if (s.prevHash !== prev) problems.push({ ...at, code: 'SIGN-CHAIN-001', message: 'sign-off chain is broken (a sign-off was removed, inserted or reordered)' });
  });
  return { ok: problems.length === 0, problems };
}
