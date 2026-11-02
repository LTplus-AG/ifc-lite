/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Explicit "check server" for an uncertain or imported entry (#6896). Reads
 * only; never writes to the server.
 *
 * - Draft topic create: the topic's generated footer names the local topic
 *   GUID and member digest. Exactly one such topic, by the signed-in author
 *   within the attempt's time window, is a committed receipt. Several are
 *   ambiguous (the coordinator picks one); none is "absent", which alone
 *   allows requeueing.
 * - Draft comment: the generated trailer names the comment id, same rule.
 * - Viewpoint: its GUID was chosen by the client, so a lookup is exact.
 * - Topic update: committed when the server's owned fields equal the update;
 *   absent when they still equal the pre-update baseline; anything else is
 *   ambiguous (someone else edited).
 * - Flow writes carry no correlation marker: title or text matches are only
 *   candidates for the coordinator, never proof.
 */

import type { BcfCommentDto, BcfTopicDto } from '@ifc-lite/bcf-api';
import { parseDraftFooter } from '../bcf-drafts/draft-footer.js';
import { commentMarker, confirmedOwnedFields, ownedFields, sameOwnedFields, statedOwnedFields } from './outbox-plan.js';
import { markDone, replaceEntry, requeue } from './outbox-state.js';
import { mutatePublication, readPublication } from './outbox-store.js';
import { sameTarget, type PublicationConnection } from './outbox-dispatch.js';
import { publicationRules } from './outbox-server-rules.js';
import type { BcfPublication, OutboxCandidate, OutboxCheck, OutboxEntry } from './outbox-types.js';

/**
 * Uncorrelated (Flow) candidates must also fall in the attempt's time window.
 * Server and client clocks differ, so the window is generous; it narrows the
 * candidates shown to the coordinator and is never proof on its own.
 */
const WINDOW_MS = 30 * 60_000;

function withinWindow(date: string | null | undefined, entry: OutboxEntry, checkedAt: Date): boolean {
  if (!date) return true;
  const value = Date.parse(date);
  if (!Number.isFinite(value)) return true;
  const start = Date.parse(entry.sentAt ?? entry.queuedAt) - WINDOW_MS;
  return value >= start && value <= checkedAt.getTime() + WINDOW_MS;
}

const PAGE = 200;
/** Below this a tie-only page cannot be a server's cap (no BCF server serves fewer per page). */
const PAGE_FLOOR = 10;
const MAX_PAGES = 250;

/**
 * Every topic of the project, and whether the list is known to be complete.
 * Only a complete list may prove a create absent (absence allows a resend).
 * A server that ignores `$skip` (profile `topicPaging: 'modified-date'`) is
 * paged by `modified_date` instead, the way `@ifc-lite/bcf-api` pulls it:
 * ascending, from the last page's latest date (inclusive; ties deduped).
 * There a short page proves nothing (the server may cap `$top` below what was
 * asked, #8656 review): the list is complete only when a page from the last
 * date brings nothing new, and not if that page was as full as the server
 * serves and all one timestamp, where more ties may hide behind the cap.
 */
async function allTopics(connection: PublicationConnection, projectId: string): Promise<{ topics: BcfTopicDto[]; complete: boolean }> {
  const byDate = publicationRules(connection).topicPaging === 'modified-date';
  const topics: BcfTopicDto[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let served = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await connection.client.getTopics(projectId, byDate
      ? { top: PAGE, orderby: 'modified_date asc', ...(cursor ? { filter: `modified_date ge ${cursor}` } : {}) }
      : { top: PAGE, skip: page * PAGE });
    const fresh = batch.filter(topic => !seen.has(topic.guid));
    for (const topic of fresh) { seen.add(topic.guid); topics.push(topic); }
    if (!byDate) {
      if (batch.length < PAGE) return { topics, complete: true };
      // A full page with nothing new (a server ignoring $skip) cannot go on.
      if (fresh.length === 0) return { topics, complete: false };
      continue;
    }
    served = Math.max(served, batch.length);
    if (batch.length === 0) return { topics, complete: true };
    if (fresh.length === 0) {
      // Only ties at the last date came back: nothing is newer, unless that page was full and all one timestamp.
      const tiesOnly = batch.every(topic => topic.modified_date === cursor);
      return { topics, complete: !(tiesOnly && batch.length >= served && page > 0 && batch.length >= PAGE_FLOOR) };
    }
    const last = batch[batch.length - 1]?.modified_date;
    if (!last || !Number.isFinite(Date.parse(last))) return { topics, complete: false };
    cursor = last;
  }
  return { topics, complete: false };
}

const candidateOf = (item: BcfTopicDto | BcfCommentDto): OutboxCandidate => ({ guid: item.guid,
  ...('topic_type' in item || 'title' in item ? { fields: statedOwnedFields(item as unknown as Record<string, unknown>) } : {}),
  ...('title' in item && item.title ? { title: item.title } : {}),
  ...('creation_author' in item && item.creation_author ? { author: item.creation_author } : {}),
  ...('author' in item && item.author ? { author: item.author } : {}),
  ...('creation_date' in item && item.creation_date ? { date: item.creation_date } : {}),
  ...('date' in item && item.date ? { date: item.date } : {}) });

function verdict(strong: OutboxCandidate[], weak: OutboxCandidate[], at: string, note?: string): OutboxCheck {
  if (strong.length === 1 && weak.length === 0) return { at, result: 'committed', candidates: strong };
  const candidates = [...strong, ...weak].slice(0, 50);
  return { at, result: candidates.length ? 'ambiguous' : 'absent', candidates, ...(note ? { note } : {}) };
}

export async function lookupEntry(connection: PublicationConnection, record: BcfPublication, entry: OutboxEntry,
  now = new Date()): Promise<OutboxCheck> {
  const at = now.toISOString();
  const projectId = record.target.projectId;
  const author = (value: string | null | undefined) => !record.target.userId || !value || value === record.target.userId;
  if (entry.operation === 'createTopic') {
    const { topics, complete } = await allTopics(connection, projectId);
    const listed = (check: OutboxCheck): OutboxCheck => check.result === 'absent' && !complete
      ? { at, result: 'unavailable', candidates: [], note: 'The server topic list could not be read completely, so absence is not proven.' } : check;
    if (record.origin === 'draft') {
      const sent = parseDraftFooter(String(entry.payload.description ?? ''));
      const ours = topics.filter(topic => {
        const footer = parseDraftFooter(topic.description ?? undefined);
        return footer && sent && footer.topicGuid === sent.topicGuid && footer.digest === sent.digest;
      });
      const strong = ours.filter(topic => author(topic.creation_author)).map(candidateOf);
      const weak = ours.filter(topic => !author(topic.creation_author)).map(candidateOf);
      return listed(verdict(strong, weak, at, weak.length ? 'Matching topics by another author need your decision.' : undefined));
    }
    const weak = topics.filter(topic => topic.title === entry.payload.title && author(topic.creation_author)
      && withinWindow(topic.creation_date, entry, now)).map(candidateOf);
    return listed(verdict([], weak, at, 'Flow writes carry no correlation marker; a title match is not proof.'));
  }
  const dependency = record.entries.find(item => item.id === entry.dependsOn);
  const topicGuid = entry.remoteTopicGuid ?? dependency?.receipt?.remoteGuid;
  if (!topicGuid) return { at, result: 'unavailable', candidates: [], note: 'The server topic is not known yet; check the topic first.' };
  if (entry.operation === 'createViewpoint') {
    try {
      const found = await connection.client.getViewpoint(projectId, topicGuid, String(entry.payload.guid));
      return { at, result: 'committed', candidates: [{ guid: found.guid }] };
    } catch (error) {
      const status = error instanceof Error ? (error as Error & { status?: unknown }).status : undefined;
      if (status === 404) return { at, result: 'absent', candidates: [] };
      throw error;
    }
  }
  if (entry.operation === 'updateTopic') {
    const remote = await connection.client.getTopic(projectId, topicGuid);
    if (sameOwnedFields(remote as unknown as Record<string, unknown>, entry.payload)) return { at, result: 'committed', candidates: [candidateOf(remote)] };
    if (entry.baseline && sameOwnedFields(remote as unknown as Record<string, unknown>, entry.baseline)) return { at, result: 'absent', candidates: [] };
    return { at, result: 'ambiguous', candidates: [candidateOf(remote)], note: `The server topic differs from both the update and its baseline: ${JSON.stringify(ownedFields(remote as unknown as Record<string, unknown>)).slice(0, 300)}` };
  }
  const comments = await connection.client.getComments(projectId, topicGuid);
  const text = String(entry.payload.comment ?? '');
  if (record.origin === 'draft' && entry.subject) {
    const ours = comments.filter(comment => comment.comment?.includes(commentMarker(entry.subject ?? '')));
    return verdict(ours.filter(comment => author(comment.author)).map(candidateOf), ours.filter(comment => !author(comment.author)).map(candidateOf), at);
  }
  return verdict([], comments.filter(comment => comment.comment === text && author(comment.author)
    && withinWindow(comment.date, entry, now)).map(candidateOf), at,
    'Flow comments carry no correlation marker; equal text is not proof.');
}

/**
 * A recovered topic write's receipt keeps what the server stored, as a write
 * response's does (#8656): the update baseline must not fall back to the sent
 * payload, or a field the server dropped reads as a remote conflict later.
 */
function recoveredFields(entry: OutboxEntry, candidate: OutboxCandidate | undefined): { fields?: Record<string, unknown> } {
  if (!candidate?.fields || (entry.operation !== 'createTopic' && entry.operation !== 'updateTopic')) return {};
  return { fields: confirmedOwnedFields(candidate.fields, entry.payload) };
}

export type CheckOutcome = { ok: true; check: OutboxCheck; record: BcfPublication } | { ok: false; reason: 'unknown' | 'target' | 'state' | 'storage' };
const CHECKABLE = new Set<OutboxEntry['state']>(['uncertain', 'blocked']);

/** Look the entry up and record the result; a unique strong match becomes a `lookup` receipt. */
export async function checkEntry(id: string, entryId: string, connection: PublicationConnection, now = new Date()): Promise<CheckOutcome> {
  const stored = await readPublication(id);
  const entry = stored?.record.entries.find(item => item.id === entryId);
  if (!stored || !entry) return { ok: false, reason: 'unknown' };
  if (!sameTarget(stored.record, connection)) return { ok: false, reason: 'target' };
  if (!CHECKABLE.has(entry.state)) return { ok: false, reason: 'state' };
  const check = await lookupEntry(connection, stored.record, entry, now);
  const record = await mutatePublication(id, current => {
    const latest = current?.entries.find(item => item.id === entryId);
    if (!current || !latest || !CHECKABLE.has(latest.state)) return null;
    const checked = { ...latest, check };
    const settled = check.result === 'committed'
      ? markDone(checked, { remoteGuid: check.candidates[0].guid, at: check.at, evidence: 'lookup', ...recoveredFields(latest, check.candidates[0]) }) : checked;
    return replaceEntry(current, settled, check.at);
  });
  return record ? { ok: true, check, record } : { ok: false, reason: 'storage' };
}

/** The coordinator picks one of the recorded candidates: the evidence is the earlier lookup, not a guess. */
export async function resolveWithCandidate(id: string, entryId: string, remoteGuid: string, now = new Date()): Promise<BcfPublication | null> {
  let applied = false;
  const record = await mutatePublication(id, current => {
    const latest = current?.entries.find(item => item.id === entryId);
    applied = !!current && !!latest && CHECKABLE.has(latest.state) && !!latest.check?.candidates.some(item => item.guid === remoteGuid);
    return applied && current && latest
      ? replaceEntry(current, markDone(latest, { remoteGuid, at: now.toISOString(), evidence: 'user-choice',
        ...recoveredFields(latest, latest.check?.candidates.find(item => item.guid === remoteGuid)) }), now.toISOString()) : null;
  });
  return applied ? record : null;
}

/**
 * Requeue only after a fresh check found no trace. A Flow entry is closed as
 * `confirmed-absent` instead, which releases its digest so the node may run again.
 */
export async function requeueAfterCheck(id: string, entryId: string, connection: PublicationConnection, now = new Date()): Promise<CheckOutcome> {
  const checked = await checkEntry(id, entryId, connection, now);
  if (!checked.ok || checked.check.result !== 'absent') return checked;
  const record = await mutatePublication(id, current => {
    const latest = current?.entries.find(item => item.id === entryId);
    if (!current || !latest || latest.check?.result !== 'absent' || !CHECKABLE.has(latest.state)) return null;
    const next = current.origin === 'flow'
      ? { ...latest, state: 'failed' as const, failure: { code: 'confirmed-absent' as const, message: 'The server has no trace of this write.', at: now.toISOString() } }
      : requeue(latest);
    return replaceEntry(current, next, now.toISOString());
  });
  return record ? { ok: true, check: checked.check, record } : { ok: false, reason: 'storage' };
}

/** A blocked update with a conflicting remote edit: overwrite deliberately, or discard the update. */
export async function settleRemoteConflict(id: string, entryId: string, choice: 'overwrite' | 'discard', now = new Date()): Promise<BcfPublication | null> {
  let applied = false;
  const record = await mutatePublication(id, current => {
    const latest = current?.entries.find(item => item.id === entryId);
    applied = !!current && latest?.state === 'blocked' && latest.blocked === 'remote-conflict';
    if (!current || !latest || !applied) return null;
    const { blocked: _blocked, ...rest } = latest;
    const next: OutboxEntry = choice === 'overwrite' ? { ...rest, state: 'queued', force: true }
      : { ...rest, state: 'failed', failure: { code: 'discarded', message: 'Update discarded after a conflicting remote edit.', at: now.toISOString() } };
    return replaceEntry(current, next, now.toISOString());
  });
  return applied ? record : null;
}
