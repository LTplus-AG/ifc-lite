/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reviewed edits of a draft batch. Every edit returns a new batch that is
 * still a partition of its findings, or a refusal naming why; membership
 * changes re-frame the affected topic's viewpoint through the clash bridge.
 */

import { decodeDraftBatch } from './draft-codec.js';
import { frameDraftMembers, memberSummary } from './draft-create.js';
import { DRAFT_LIMITS, findingIdentity, type DraftBatch, type DraftTopic } from './draft-types.js';

export type DraftEditResult = { ok: true; batch: DraftBatch } | { ok: false; reason: DraftEditRefusal };
export type DraftEditRefusal = 'unknown-topic' | 'empty-split' | 'merge-needs-two' | 'invalid';

function commit(batch: DraftBatch, topics: DraftTopic[], now = new Date()): DraftEditResult {
  const next = decodeDraftBatch(JSON.parse(JSON.stringify({ ...batch, topics, modifiedAt: now.toISOString() })));
  return next ? { ok: true, batch: next } : { ok: false, reason: 'invalid' };
}

async function reframe(batch: DraftBatch, topic: DraftTopic): Promise<DraftTopic> {
  const viewpoint = await frameDraftMembers(topic.members, batch.source.worldOffset);
  const { viewpoint: _previous, ...rest } = topic;
  return viewpoint ? { ...rest, viewpoint } : rest;
}

export type DraftFieldEdit = Partial<Pick<DraftTopic, 'title' | 'description' | 'topicType' | 'topicStatus' | 'priority' | 'labels' | 'assignedTo'>>;

/** Field edits keep membership and viewpoint; an empty assignee clears the mapping. */
export function editDraftTopic(batch: DraftBatch, guid: string, edit: DraftFieldEdit): DraftEditResult {
  if (!batch.topics.some(topic => topic.guid === guid)) return { ok: false, reason: 'unknown-topic' };
  return commit(batch, batch.topics.map(topic => {
    if (topic.guid !== guid) return topic;
    const next: DraftTopic = { ...topic, ...edit };
    if (!next.assignedTo) delete next.assignedTo;
    if (!next.priority) delete next.priority;
    return next;
  }));
}

export async function removeDraftMember(batch: DraftBatch, guid: string, identity: string): Promise<DraftEditResult> {
  const topic = batch.topics.find(item => item.guid === guid);
  if (!topic) return { ok: false, reason: 'unknown-topic' };
  const members = topic.members.filter(member => findingIdentity(member) !== identity);
  const updated = await reframe(batch, { ...topic, members });
  return commit(batch, batch.topics.map(item => item.guid === guid ? updated : item));
}

/**
 * Move the chosen findings into a new topic right after the original. Both
 * halves keep the original origin; reconciliation then reports new group
 * matches as unplaced instead of guessing which half they belong to.
 */
export async function splitDraftTopic(batch: DraftBatch, guid: string, identities: ReadonlySet<string>, title?: string): Promise<DraftEditResult> {
  const topic = batch.topics.find(item => item.guid === guid);
  if (!topic) return { ok: false, reason: 'unknown-topic' };
  const moved = topic.members.filter(member => identities.has(findingIdentity(member)));
  const kept = topic.members.filter(member => !identities.has(findingIdentity(member)));
  if (moved.length === 0 || kept.length === 0) return { ok: false, reason: 'empty-split' };
  const original = await reframe(batch, { ...topic, members: kept, description: memberSummary(kept) });
  const split = await reframe(batch, { ...topic, guid: crypto.randomUUID(), title: (title?.trim() || `${topic.title} (split)`).slice(0, DRAFT_LIMITS.title),
    description: memberSummary(moved), members: moved, comments: [] });
  return commit(batch, batch.topics.flatMap(item => item.guid === guid ? [original, split] : [item]));
}

/**
 * Merge into the first chosen topic, which keeps its GUID (and so any
 * published server mapping). Merged-away topics' comments move with their
 * findings; their server topics, if any, are left untouched.
 */
export async function mergeDraftTopics(batch: DraftBatch, guids: readonly string[]): Promise<DraftEditResult> {
  const chosen = batch.topics.filter(topic => guids.includes(topic.guid));
  if (chosen.length < 2) return { ok: false, reason: 'merge-needs-two' };
  const [target, ...absorbed] = chosen;
  const members = chosen.flatMap(topic => topic.members);
  const merged = await reframe(batch, { ...target, members, description: memberSummary(members),
    comments: chosen.flatMap(topic => topic.comments) });
  const removed = new Set(absorbed.map(topic => topic.guid));
  return commit(batch, batch.topics.flatMap(topic => removed.has(topic.guid) ? [] : topic.guid === target.guid ? [merged] : [topic]));
}

export function addDraftComment(batch: DraftBatch, guid: string, text: string): DraftEditResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'invalid' };
  return commit(batch, batch.topics.map(topic => topic.guid === guid
    ? { ...topic, comments: [...topic.comments, { id: crypto.randomUUID(), text: trimmed.slice(0, DRAFT_LIMITS.comment) }] } : topic));
}

export function deleteDraftTopic(batch: DraftBatch, guid: string): DraftEditResult {
  if (!batch.topics.some(topic => topic.guid === guid)) return { ok: false, reason: 'unknown-topic' };
  return commit(batch, batch.topics.filter(topic => topic.guid !== guid));
}
