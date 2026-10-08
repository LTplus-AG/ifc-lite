/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Send queued outbox entries, one durable step at a time (#6896):
 *
 * 1. preflight the project's permissions and vocabulary (nothing sent on refusal);
 * 2. per entry, commit `sending` with CAS — if storage refuses, stop before the request;
 * 3. send once; commit `done` with the server receipt, `failed` for an HTTP
 *    refusal, or `uncertain` when no answer arrived after dispatch.
 *
 * Uncertain/blocked entries and everything depending on them are skipped,
 * never resent. Authentication: the connected client refreshes the token
 * once on HTTP 401 and repeats that request; a 401 means the server rejected
 * it before applying anything, so the repeat cannot duplicate an effect. A
 * second 401 is recorded as a definite `auth` failure.
 */

import type { BcfApiClient, BcfCommentWriteDto, BcfRequestOptions, BcfTopicWriteDto, BcfViewpointDto } from '@ifc-lite/bcf-api';
import { normalizeServerUrl, sameOwnedFields } from './outbox-plan.js';
import { preflightPublication, type PreflightReport } from './outbox-preflight.js';
import { markBlocked, markDone, markFailed, markSending, markUncertain, replaceEntry, waitingOn } from './outbox-state.js';
import { inFlightEntries, mutatePublication, readPublication } from './outbox-store.js';
import type { BcfPublication, OutboxEntry, OutboxFailure, OutboxReceipt } from './outbox-types.js';

export type PublicationClient = Pick<BcfApiClient, 'getProject' | 'getExtensions' | 'getTopics' | 'getTopic' | 'createTopic'
  | 'updateTopic' | 'getComments' | 'createComment' | 'getViewpoint' | 'createViewpoint'>;

export interface PublicationConnection {
  client: PublicationClient;
  serverUrl: string;
  userId: string;
}

export interface DispatchOptions {
  signal?: AbortSignal;
  /** Per-request wall-clock limit; expiry after dispatch is an unknown outcome. */
  timeoutMs?: number;
  now?: () => Date;
}

export interface DispatchReceipt { entryId: string; operation: OutboxEntry['operation']; topicGuid: string; remoteGuid: string }

export interface DispatchReport {
  preflight?: PreflightReport;
  /** Why dispatch stopped early, if it did. */
  stopped?: 'target' | 'preflight' | 'storage' | 'aborted';
  sent: number;
  receipts: DispatchReceipt[];
  failed: string[];
  uncertain: string[];
  blocked: string[];
  /** Queued entries skipped because an entry they depend on is not done. */
  waiting: string[];
}

/** HTTP status from a BCF/Foundation API error, without loading the connector eagerly. */
function httpStatus(error: unknown): number | undefined {
  return error instanceof Error && /ApiError$|AuthenticationError$/.test(error.name)
    && typeof (error as Error & { status?: unknown }).status === 'number' ? (error as Error & { status: number }).status : undefined;
}

/**
 * Definite only when the server answered with a refusal that applies nothing.
 * 5xx (a proxy timeout can follow a commit), 409 (the effect may already
 * exist) and anything without a status (lost connection, abort, timeout,
 * unreadable body) leave the outcome unknown.
 */
export function classifyWriteError(error: unknown, at: string): { state: 'failed' | 'uncertain'; failure: OutboxFailure } {
  const status = httpStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  if (status === undefined || status === 0) return { state: 'uncertain', failure: { code: 'no-response', message, at } };
  if (status >= 500) return { state: 'uncertain', failure: { code: 'server-error', message, status, at } };
  if (status === 409) return { state: 'uncertain', failure: { code: 'conflict-exists', message, status, at } };
  const code: OutboxFailure['code'] = status === 401 ? 'auth' : status === 403 ? 'permission' : 'rejected';
  return { state: 'failed', failure: { code, message, status, at } };
}

function remoteTopic(record: BcfPublication, entry: OutboxEntry): { guid?: string; actions?: string[] } {
  if (entry.remoteTopicGuid) return { guid: entry.remoteTopicGuid };
  const dependency = record.entries.find(item => item.id === entry.dependsOn);
  return { guid: dependency?.receipt?.remoteGuid, actions: dependency?.receipt?.topicActions };
}

type Prepared = { send: (request: BcfRequestOptions) => Promise<OutboxReceipt> } | { refuse: OutboxFailure } | { block: 'remote-conflict' };

/** Per-entry checks that need the server topic: its advertised actions and, for updates, unchanged owned fields. */
async function prepare(connection: PublicationConnection, record: BcfPublication, entry: OutboxEntry, request: BcfRequestOptions,
  at: string): Promise<Prepared> {
  const { client } = connection;
  const projectId = record.target.projectId;
  const receipt = (remoteGuid: string, topicActions?: string[] | null): OutboxReceipt =>
    ({ remoteGuid, at, evidence: 'response', ...(Array.isArray(topicActions) ? { topicActions: [...topicActions] } : {}) });
  if (entry.operation === 'createTopic') {
    return { send: async options => {
      const created = await client.createTopic(projectId, entry.payload as unknown as BcfTopicWriteDto, options);
      return receipt(created.guid, created.authorization?.topic_actions);
    } };
  }
  const topic = remoteTopic(record, entry);
  if (!topic.guid) return { refuse: { code: 'rejected', message: 'The server topic of this entry is unknown.', at } };
  const topicGuid = topic.guid;
  const denied = (action: string, actions?: string[] | null): Prepared | undefined =>
    Array.isArray(actions) && !actions.includes(action)
      ? { refuse: { code: 'permission', message: `The server does not allow ${action} on this topic.`, at } } : undefined;
  if (entry.operation === 'updateTopic') {
    const remote = await client.getTopic(projectId, topicGuid, request);
    const refusal = denied('update', remote.authorization?.topic_actions);
    if (refusal) return refusal;
    if (!entry.force && !sameOwnedFields(remote as unknown as Record<string, unknown>, entry.baseline)) return { block: 'remote-conflict' };
    return { send: async options => {
      const updated = await client.updateTopic(projectId, topicGuid, entry.payload as unknown as BcfTopicWriteDto, options);
      return receipt(updated.guid, updated.authorization?.topic_actions);
    } };
  }
  if (entry.operation === 'createComment') {
    const refusal = denied('createComment', topic.actions);
    if (refusal) return refusal;
    return { send: async options => receipt((await client.createComment(projectId, topicGuid,
      entry.payload as unknown as BcfCommentWriteDto, options)).guid) };
  }
  const refusal = denied('createViewpoint', topic.actions);
  if (refusal) return refusal;
  return { send: async options => receipt((await client.createViewpoint(projectId, topicGuid,
    entry.payload as unknown as BcfViewpointDto, options)).guid) };
}

export function sameTarget(record: BcfPublication, connection: Pick<PublicationConnection, 'serverUrl' | 'userId'>): boolean {
  return normalizeServerUrl(record.target.serverUrl) === normalizeServerUrl(connection.serverUrl)
    && (!record.target.userId || record.target.userId === connection.userId);
}

export async function dispatchPublication(id: string, connection: PublicationConnection, options: DispatchOptions = {}): Promise<DispatchReport> {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const request: BcfRequestOptions = { ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
  const report: DispatchReport = { sent: 0, receipts: [], failed: [], uncertain: [], blocked: [], waiting: [] };
  const stored = await readPublication(id);
  if (!stored || !sameTarget(stored.record, connection)) return { ...report, stopped: 'target' };
  report.preflight = await preflightPublication(connection.client, stored.record, request, options.now?.());
  if (!report.preflight.ok) return { ...report, stopped: 'preflight' };

  for (const { id: entryId } of stored.record.entries) {
    if (options.signal?.aborted) return { ...report, stopped: 'aborted' };
    const current = await readPublication(id);
    const entry = current?.record.entries.find(item => item.id === entryId);
    if (!current || !entry || entry.state !== 'queued') continue;
    if (waitingOn(current.record, entry)) { report.waiting.push(entry.id); continue; }
    const at = now();
    let prepared: Prepared;
    try { prepared = await prepare(connection, current.record, entry, request, at); }
    catch (error) {
      // A failed read sent nothing; the entry stays queued for the next attempt.
      console.warn('[BCF outbox] Pre-send check failed; entry stays queued', error);
      report.waiting.push(entry.id);
      continue;
    }
    if ('refuse' in prepared || 'block' in prepared) {
      const changed = await mutatePublication(id, record => {
        const latest = record?.entries.find(item => item.id === entryId);
        if (!record || latest?.state !== 'queued') return null;
        return replaceEntry(record, 'refuse' in prepared ? markFailed(latest, prepared.refuse) : markBlocked(latest, prepared.block), at);
      });
      if (!changed) return { ...report, stopped: 'storage' };
      ('refuse' in prepared ? report.failed : report.blocked).push(entryId);
      continue;
    }
    // The intent is durable before the request leaves; a refused write means nothing is sent.
    const claimed = await mutatePublication(id, record => {
      const latest = record?.entries.find(item => item.id === entryId);
      return record && latest?.state === 'queued' ? replaceEntry(record, markSending(latest, at), at) : null;
    });
    if (claimed?.entries.find(item => item.id === entryId)?.state !== 'sending') return { ...report, stopped: 'storage' };
    inFlightEntries.add(entryId);
    let outcome: { apply: (latest: OutboxEntry) => OutboxEntry; receipt?: OutboxReceipt };
    try {
      const receipt = await prepared.send(request);
      report.sent += 1;
      report.receipts.push({ entryId, operation: entry.operation, topicGuid: entry.topicGuid, remoteGuid: receipt.remoteGuid });
      outcome = { apply: latest => markDone(latest, receipt), receipt };
    } catch (error) {
      report.sent += 1;
      const classified = classifyWriteError(error, now());
      (classified.state === 'failed' ? report.failed : report.uncertain).push(entryId);
      outcome = { apply: latest => classified.state === 'failed' ? markFailed(latest, classified.failure) : markUncertain(latest, classified.failure) };
    } finally {
      inFlightEntries.delete(entryId);
    }
    // If this commit is refused the row stays `sending`, which recovery turns into `uncertain`: never a resend.
    const settled = await mutatePublication(id, record => {
      const latest = record?.entries.find(item => item.id === entryId);
      if (!record || !latest || latest.state === 'done') return null;
      // Another tab may have marked this entry uncertain meanwhile; this attempt's own answer still settles it.
      if (latest.state === 'uncertain' && !('receipt' in outcome)) return null;
      return replaceEntry(record, outcome.apply(latest), now());
    });
    if (!settled) return { ...report, stopped: 'storage' };
  }
  return report;
}
