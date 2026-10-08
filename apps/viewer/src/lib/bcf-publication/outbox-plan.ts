/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turn a reviewed draft batch into outbox entries for one server project
 * (#6896). Planning is idempotent against the existing record: a topic with a
 * create entry never gets a second one, so rerunning the same batch updates
 * the topics it already created instead of duplicating them; only
 * definitive failures are requeued, never unknown outcomes.
 */

import type { BCFTopic } from '@ifc-lite/bcf';
import { loadApi } from '../../services/bcf-server-session.js';
import { digestStrings, describeWithFooter } from '../bcf-drafts/draft-footer.js';
import type { DraftBatch, DraftTopic } from '../bcf-drafts/draft-types.js';
import { requeue } from './outbox-state.js';
import type { BcfPublication, OutboxEntry, OutboxOperation, PublicationTarget } from './outbox-types.js';

/** Topic fields the publisher owns and compares for update conflicts. */
const OWNED_FIELDS = ['title', 'description', 'topic_type', 'topic_status', 'priority', 'labels', 'assigned_to', 'stage', 'due_date'] as const;

export function ownedFields(dto: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const owned: Record<string, unknown> = {};
  for (const field of OWNED_FIELDS) {
    const value = dto?.[field];
    if (value === undefined || value === null || Array.isArray(value) && value.length === 0) continue;
    owned[field] = Array.isArray(value) ? [...value].map(String).sort() : value;
  }
  return owned;
}

export function sameOwnedFields(left: Readonly<Record<string, unknown>> | undefined, right: Readonly<Record<string, unknown>> | undefined): boolean {
  return JSON.stringify(ownedFields(left)) === JSON.stringify(ownedFields(right));
}

/** Same base-URL cleanup as the connector (trailing slashes, pasted version segment), without loading it eagerly. */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/\d+\.\d+$/, '');
}

export function normalizedTarget(target: PublicationTarget): PublicationTarget {
  return { ...target, serverUrl: normalizeServerUrl(target.serverUrl) };
}

/** One record per batch and server project, so concurrent tabs plan into the same CAS row. */
export function draftPublicationId(batchId: string, target: PublicationTarget): string {
  const { serverUrl, projectId } = normalizedTarget(target);
  return `draft-${digestStrings([`b:${batchId}`, `s:${serverUrl}`, `p:${projectId}`])}`;
}

/** Connector, project, effect and exact payload: equal digests are the same intended write. */
export function entryDigest(target: PublicationTarget, operation: OutboxOperation, topicKey: string, payload: unknown): string {
  const { serverUrl, projectId } = normalizedTarget(target);
  return digestStrings([JSON.stringify([serverUrl, projectId, operation, topicKey, payload])]);
}

/** Draft comments carry a short trailer so a server check can recognise them after a lost response. */
export function commentMarker(commentId: string): string {
  return `— ifc-lite draft comment ${commentId}`;
}

function topicForServer(batch: DraftBatch, topic: DraftTopic): BCFTopic {
  return { guid: topic.guid, title: topic.title, description: describeWithFooter(topic, { batchId: batch.id }),
    topicType: topic.topicType, topicStatus: topic.topicStatus, ...(topic.priority ? { priority: topic.priority } : {}),
    ...(topic.labels.length ? { labels: topic.labels } : {}), ...(topic.assignedTo ? { assignedTo: topic.assignedTo } : {}),
    comments: [], viewpoints: [] };
}

export interface PublicationPlan {
  record: BcfPublication;
  added: number;
  requeued: number;
  /** Published topics no longer in the batch (merged away or deleted); their server topics stay untouched. */
  orphaned: string[];
}

export async function planDraftPublication(batch: DraftBatch, existing: BcfPublication | undefined, rawTarget: PublicationTarget,
  now = new Date()): Promise<PublicationPlan> {
  const api = await loadApi();
  const target = normalizedTarget(rawTarget);
  const at = now.toISOString();
  let requeued = 0, added = 0;
  const entries: OutboxEntry[] = (existing?.entries ?? []).map(entry => {
    if (entry.state !== 'failed' || entry.failure?.code === 'discarded' || entry.failure?.code === 'confirmed-absent') return entry;
    requeued += 1;
    return requeue(entry);
  });
  const entry = (operation: OutboxOperation, topicGuid: string, payload: Record<string, unknown>,
    extra: Partial<OutboxEntry> = {}): OutboxEntry => {
    added += 1;
    return { id: crypto.randomUUID(), operation, topicGuid, payload, digest: entryDigest(target, operation, topicGuid, payload),
      state: 'queued', attempts: 0, queuedAt: at, ...extra };
  };
  const withPayload = (item: OutboxEntry, payload: Record<string, unknown>): OutboxEntry =>
    ({ ...item, payload, digest: entryDigest(target, item.operation, item.topicGuid, payload) });

  for (const topic of batch.topics) {
    const write = { ...api.topicToApiWrite(topicForServer(batch, topic)) } as Record<string, unknown>;
    let create = entries.find(item => item.operation === 'createTopic' && item.topicGuid === topic.guid);
    if (!create) {
      create = entry('createTopic', topic.guid, write);
      entries.push(create);
    } else if (create.state === 'queued') {
      // Never sent: carry the latest reviewed fields instead of stale ones.
      const index = entries.indexOf(create);
      create = entries[index] = withPayload(create, write);
    } else if (create.state === 'done') {
      const published = [...entries].reverse().find(item => item.topicGuid === topic.guid && item.state === 'done'
        && (item.operation === 'updateTopic' || item.operation === 'createTopic'));
      const pending = entries.findIndex(item => item.operation === 'updateTopic' && item.topicGuid === topic.guid
        && item.state !== 'done' && item.state !== 'failed');
      if (!sameOwnedFields(published?.payload, write)) {
        if (pending >= 0 && entries[pending].state === 'queued') entries[pending] = withPayload(entries[pending], write);
        else if (pending < 0) entries.push(entry('updateTopic', topic.guid, write, { dependsOn: create.id, baseline: ownedFields(published?.payload) }));
      }
    }
    if (topic.viewpoint && !entries.some(item => item.operation === 'createViewpoint' && item.subject === topic.viewpoint?.guid)) {
      entries.push(entry('createViewpoint', topic.guid, { ...api.viewpointToApi(topic.viewpoint) } as Record<string, unknown>,
        { dependsOn: create.id, subject: topic.viewpoint.guid }));
    }
    for (const comment of topic.comments) {
      if (entries.some(item => item.operation === 'createComment' && item.subject === comment.id)) continue;
      entries.push(entry('createComment', topic.guid, { comment: `${comment.text}\n\n${commentMarker(comment.id)}` },
        { dependsOn: create.id, subject: comment.id }));
    }
  }
  const current = new Set(batch.topics.map(topic => topic.guid));
  const orphaned = entries.filter(item => item.operation === 'createTopic' && item.state === 'done' && !current.has(item.topicGuid))
    .map(item => item.topicGuid);
  const record: BcfPublication = existing
    ? { ...existing, batchName: batch.name, target: { ...existing.target, projectName: target.projectName ?? existing.target.projectName },
      updatedAt: at, entries }
    : { version: 1, id: draftPublicationId(batch.id, target), origin: 'draft', batchId: batch.id, batchName: batch.name, target,
      createdAt: at, updatedAt: at, entries };
  return { record, added, requeued, orphaned };
}
