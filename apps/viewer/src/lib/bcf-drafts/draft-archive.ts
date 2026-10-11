/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Draft batches <-> .bcfzip (#6896). The archive is ordinary BCF 2.1 written
 * by the native writer; the finding mapping rides in each topic's generated
 * description footer, so other tools see a readable topic and a reimport
 * restores the batch, topic GUIDs and members exactly.
 */

import { createBCFComment, createBCFProject, readBCF, writeBCF, type BCFProject, type BCFTopic } from '@ifc-lite/bcf';
import { decodeDraftBatch, decodeViewpoint, draftOwnershipConflict, type DraftOwnershipConflict } from './draft-codec.js';
import { DRAFT_FOOTER_MARKER, describeWithFooter, parseDraftFooter } from './draft-footer.js';
import type { DraftBatch, DraftSource, DraftTopic } from './draft-types.js';

export function draftBatchToProject(batch: DraftBatch, author: string, now = new Date()): BCFProject {
  const project = createBCFProject({ name: batch.name, version: '2.1' });
  const date = now.toISOString();
  for (const topic of batch.topics) {
    const bcf: BCFTopic = {
      guid: topic.guid, title: topic.title, topicType: topic.topicType, topicStatus: topic.topicStatus,
      description: describeWithFooter(topic, { batchId: batch.id, full: { batchName: batch.name, source: batch.source } }),
      ...(topic.priority ? { priority: topic.priority } : {}), ...(topic.labels.length ? { labels: [...topic.labels] } : {}),
      ...(topic.assignedTo ? { assignedTo: topic.assignedTo } : {}),
      creationDate: batch.createdAt, creationAuthor: author, modifiedDate: date, modifiedAuthor: author,
      comments: topic.comments.map(comment => ({ ...createBCFComment({ author, comment: comment.text }), guid: comment.id, date })),
      viewpoints: topic.viewpoint ? [structuredClone(topic.viewpoint)] : [],
    };
    project.topics.set(bcf.guid, bcf);
  }
  return project;
}

export function exportDraftArchive(batch: DraftBatch, author: string): Promise<Blob> {
  return writeBCF(draftBatchToProject(batch, author));
}

export interface DraftArchiveImport {
  batches: DraftBatch[];
  /** Plain BCF topics without a mapping footer; imported unmapped (no findings). */
  unmapped: number;
  /**
   * Footers present but inconsistent: edited member or source lines (imported unmapped), or a reviewed
   * topic whose origin no longer reads (its clash members kept, its reviewed findings dropped).
   */
  damaged: number;
  /** Of `damaged`: mapped topics that kept their clash members but lost their reviewed source findings. */
  droppedFindings: number;
}

/** Why a whole archive was refused; the dialog shows a translated message per reason. */
export type DraftArchiveFailure = DraftOwnershipConflict | 'unreadable';

const FAILURE_MESSAGES: Record<DraftArchiveFailure, string> = {
  topic: 'The archive holds one topic GUID twice; nothing was imported',
  member: 'The archive maps one clash finding to several topics; nothing was imported',
  'source-finding': 'The archive maps one reviewed finding to several topics; nothing was imported',
  unreadable: 'The archive topics could not be read as drafts; nothing was imported',
};

/** An archive refused as a whole, with the exact reason (never a guessed one). */
export class DraftArchiveError extends Error {
  constructor(readonly reason: DraftArchiveFailure) {
    super(FAILURE_MESSAGES[reason]);
    this.name = 'DraftArchiveError';
  }
}

/** Provenance of topics that arrived without their clash run. */
function archiveSource(at: string): DraftSource {
  return { kind: 'archive', runDigest: '0000000000000000', rules: [], findingCount: 0, capturedAt: at };
}

function topicFields(topic: BCFTopic): Pick<DraftTopic, 'title' | 'topicType' | 'topicStatus' | 'labels' | 'comments'> & Partial<DraftTopic> {
  const viewpoint = topic.viewpoints[0] ? decodeViewpoint(JSON.parse(JSON.stringify({ ...topic.viewpoints[0], snapshot: undefined, snapshotData: undefined }))) : null;
  return {
    title: topic.title.slice(0, 200) || 'Untitled topic', topicType: topic.topicType ?? 'Issue', topicStatus: topic.topicStatus ?? 'Open',
    ...(topic.priority ? { priority: topic.priority } : {}), labels: (topic.labels ?? []).slice(0, 20),
    ...(topic.assignedTo ? { assignedTo: topic.assignedTo } : {}), ...(viewpoint ? { viewpoint } : {}),
    comments: topic.comments.filter(comment => comment.comment.trim()).slice(0, 100)
      .map(comment => ({ id: comment.guid, text: comment.comment.slice(0, 4_000) })),
  };
}

/**
 * Read an archive back into batches. Mapped topics regroup by their footer
 * batch; plain topics become one unmapped "archive" batch. Each batch is
 * revalidated, so an archive that would make two topics claim one clash
 * finding or one reviewed source finding is refused rather than imported
 * half-way, with a `DraftArchiveError` naming the conflict.
 */
export async function importDraftArchive(data: ArrayBuffer, now = new Date()): Promise<DraftArchiveImport> {
  const project = await readBCF(data);
  const at = now.toISOString();
  const mapped = new Map<string, { name: string; source: DraftSource; topics: DraftTopic[] }>();
  const plain: DraftTopic[] = [];
  let damaged = 0, droppedFindings = 0;
  for (const topic of project.topics.values()) {
    const footer = parseDraftFooter(topic.description);
    const markerAt = topic.description?.lastIndexOf(DRAFT_FOOTER_MARKER) ?? -1;
    if (!footer?.members) {
      if (markerAt >= 0) damaged += 1;
      // A generated footer is never shown as human text, even when it was damaged.
      const human = markerAt >= 0 ? (topic.description ?? '').slice(0, markerAt).trim() : topic.description ?? '';
      plain.push({ ...topicFields(topic), guid: topic.guid, description: human.slice(0, 10_000),
        origin: { kind: 'archive' }, members: [] });
      continue;
    }
    if (footer.droppedSourceFindings) { damaged += 1; droppedFindings += 1; }
    const decodedSource = decodeDraftBatch({ version: 1, id: 'probe', name: 'probe', createdAt: at, modifiedAt: at,
      source: footer.source, topics: [] })?.source;
    const entry = mapped.get(footer.batchId) ?? { name: footer.batchName ?? project.name ?? 'Imported BCF drafts',
      source: decodedSource ?? archiveSource(at), topics: [] };
    entry.topics.push({ ...topicFields(topic), guid: footer.topicGuid, description: footer.human.slice(0, 10_000),
      origin: footer.origin ?? { kind: 'archive' }, members: footer.members,
      ...(footer.sourceFindings ? { sourceFindings: footer.sourceFindings } : {}) });
    mapped.set(footer.batchId, entry);
  }
  const batches: DraftBatch[] = [];
  for (const [id, entry] of mapped) {
    const batch = decodeDraftBatch({ version: 1, id, name: entry.name, createdAt: at, modifiedAt: at, source: entry.source, topics: entry.topics });
    if (!batch) throw new DraftArchiveError(draftOwnershipConflict(entry.topics) ?? 'unreadable');
    batches.push(batch);
  }
  if (plain.length) {
    const batch = decodeDraftBatch({ version: 1, id: crypto.randomUUID(), name: project.name || 'Imported BCF topics', createdAt: at,
      modifiedAt: at, source: archiveSource(at), topics: plain });
    if (!batch) throw new DraftArchiveError(draftOwnershipConflict(plain) ?? 'unreadable');
    batches.push(batch);
  }
  return { batches, unmapped: plain.length - (damaged - droppedFindings), damaged, droppedFindings };
}
