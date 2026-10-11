/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Framework-free view model of a revision log: a timeline with labels,
 * sign-offs, what changed against the parent (plain language) and
 * whether the entry passed verification.
 */

import type { SupportedLocale } from '@ifc-lite/ids';
import { changelog } from '../diff/changelog.js';
import { diffDocuments } from '../diff/diff.js';
import type { Uuid } from '../uuid.js';
import { findRevision, type RevisionLabel, type RevisionLog } from './revision.js';
import { verifyRevisionLog, type RevisionProblem } from './verify.js';

export interface TimelineEntry {
  revId: Uuid;
  label: RevisionLabel;
  author: string;
  at: string;
  message?: string;
  /** Short hash for display. */
  shortHash: string;
  isHead: boolean;
  readOnly: boolean;
  signOffs: { by: string; role?: string; at: string; statement: string }[];
  /** Changes against the parent revision, as sentences. */
  changes: string[];
  problems: RevisionProblem[];
}

export interface RevisionTimeline {
  entries: TimelineEntry[];
  /** The whole log verified. */
  verified: boolean;
}

export function revisionTimeline(log: RevisionLog, locale: SupportedLocale = 'en'): RevisionTimeline {
  const { ok, problems } = verifyRevisionLog(log);
  const head = log.revisions[log.revisions.length - 1]?.revId;
  const entries = log.revisions.map((r): TimelineEntry => {
    const parent = r.parentRevId ? findRevision(log, r.parentRevId) : undefined;
    const changes = parent ? changelog(diffDocuments(parent.snapshot, r.snapshot), { locale }).map((l) => l.text) : [];
    return {
      revId: r.revId,
      label: r.label,
      author: r.author,
      at: r.at,
      ...(r.message !== undefined ? { message: r.message } : {}),
      shortHash: r.hash.slice(0, 12),
      isHead: r.revId === head,
      readOnly: r.label === 'released',
      signOffs: log.signOffs
        .filter((s) => s.revId === r.revId)
        .map((s) => ({ by: s.by, at: s.at, statement: s.statement, ...(s.role !== undefined ? { role: s.role } : {}) })),
      changes,
      problems: problems.filter((p) => p.revId === r.revId),
    };
  });
  return { entries: entries.reverse(), verified: ok };
}
