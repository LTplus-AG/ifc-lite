/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's `FlowHost.bcfWrites` (#6896): Flow `bcf.createTopic` /
 * `bcf.addComment` writes use the same durable outbox as draft publication.
 * The intent is committed as `sending` before the request leaves, the
 * receipt or failure after; an identical write whose earlier attempt is
 * still unresolved is refused without sending. The node's bearer token is
 * never persisted.
 */

import type { BcfWriteGateway, BcfWriteIntent } from '@ifc-lite/flow-nodes';
import { BcfApiError } from '@ifc-lite/bcf-api';
import { digestStrings } from '../bcf-drafts/draft-footer.js';
import { classifyWriteError } from './outbox-dispatch.js';
import { entryDigest, normalizeServerUrl } from './outbox-plan.js';
import { markDone, markFailed, markUncertain, replaceEntry } from './outbox-state.js';
import { inFlightEntries, mutatePublication } from './outbox-store.js';
import type { BcfPublication, OutboxEntry, PublicationTarget } from './outbox-types.js';

const UNRESOLVED = new Set<OutboxEntry['state']>(['queued', 'sending', 'uncertain', 'blocked']);
const INTENT_KEYS = ['nodeType', 'operation', 'baseUrl', 'version', 'projectId', 'topicGuid', 'payload'];
const TOPIC_KEYS = ['title', 'topic_type', 'topic_status', 'priority', 'labels', 'assigned_to', 'stage', 'description', 'due_date'];
const COMMENT_KEYS = ['comment', 'viewpoint_guid', 'reply_to_comment_guid'];
const SCHEMA_KEYS = new Set([...INTENT_KEYS, ...TOPIC_KEYS, ...COMMENT_KEYS]);

export function flowPublicationId(target: Pick<PublicationTarget, 'serverUrl' | 'projectId'>): string {
  return `flow-${digestStrings([`s:${normalizeServerUrl(target.serverUrl)}`, `p:${target.projectId}`])}`;
}

export class BcfWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BcfWriteRefusedError';
  }
}

function host(url: string): string {
  try { return new URL(url).host; }
  catch (error) { console.warn('[BCF outbox] Flow base URL is not absolute', error); return url; }
}

/** Fixed schema names are protocol, but credential values and unknown fields cannot be journalled. */
function admitIntent(intent: BcfWriteIntent, secrets: readonly string[]): void {
  const refuse = (): never => { throw new BcfWriteRefusedError('BCF publication refused: invalid intent; credentials must not enter durable state.'); };
  const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  if (!intent || typeof intent !== 'object' || Object.keys(intent).some(key => !INTENT_KEYS.includes(key))
    || !isText(intent.baseUrl) || !isText(intent.version) || !isText(intent.projectId)
    || !['createTopic', 'createComment'].includes(intent.operation)) refuse();
  const comment = intent.operation === 'createComment';
  if (intent.nodeType !== (comment ? 'bcf.addComment' : 'bcf.createTopic')
    || (comment ? !isText(intent.topicGuid) : intent.topicGuid !== undefined)) refuse();
  const payload = intent.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !(comment ? COMMENT_KEYS : TOPIC_KEYS).includes(key))
    || !isText(Reflect.get(payload, comment ? 'comment' : 'title'))) refuse();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (key === 'labels' ? !Array.isArray(value) || !value.every(item => typeof item === 'string') : typeof value !== 'string') refuse();
  }
  let url: URL;
  try { url = new URL(intent.baseUrl); } catch { return refuse(); }
  if (url.username || url.password) refuse();
  const serialized = JSON.stringify(intent);
  if (/authorization\s*:\s*bearer\s+|"Bearer (?=[A-Za-z0-9._~+\/=-]*[0-9._~+\/=-])[A-Za-z0-9._~+\/=-]{8,}"|[?&](?:access_token|token|password|secret)=|"(?:authorization|password|access_token|token|secret)"\s*:/i.test(serialized)) refuse();
  const encoded = secrets.filter(secret => secret.length > 0).map(secret => JSON.stringify(secret).slice(1, -1));
  const reject = (value: unknown) => {
    const text = JSON.stringify(value);
    if (text !== undefined && encoded.some(secret => text.includes(secret))) refuse();
  };
  const pending: unknown[] = [intent];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) { for (const item of value) pending.push(item); }
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) { if (!SCHEMA_KEYS.has(key)) reject(key); pending.push(item); }
    } else reject(value);
  }
}

export function createViewerBcfWriteGateway(now: () => Date = () => new Date()): BcfWriteGateway {
  return {
    async write<T extends { guid: string }>(intent: BcfWriteIntent, send: () => Promise<T>, secrets: readonly string[] = []): Promise<T> {
      const sensitive = secrets.filter(secret => secret.length > 0);
      admitIntent(intent, sensitive);
      const target: PublicationTarget = { serverUrl: normalizeServerUrl(intent.baseUrl), projectId: intent.projectId, userId: '' };
      const id = flowPublicationId(target);
      const topicKey = intent.topicGuid ?? '';
      const payload = JSON.parse(JSON.stringify(intent.payload)) as Record<string, unknown>;
      const digest = entryDigest(target, intent.operation, topicKey, payload);
      const entryId = crypto.randomUUID();
      const at = now().toISOString();
      let unresolved: OutboxEntry | undefined;
      const claimed = await mutatePublication(id, current => {
        const record: BcfPublication = current ?? { version: 1, id, origin: 'flow', target, createdAt: at, updatedAt: at, entries: [] };
        unresolved = record.entries.find(entry => entry.digest === digest && UNRESOLVED.has(entry.state));
        if (unresolved) return null;
        const entry: OutboxEntry = { id: entryId, operation: intent.operation, topicGuid: '', ...(intent.topicGuid ? { remoteTopicGuid: intent.topicGuid } : {}),
          payload, digest, state: 'sending', attempts: 1, queuedAt: at, sentAt: at };
        return { ...record, updatedAt: at, entries: [...record.entries, entry] };
      });
      if (unresolved) {
        throw new BcfWriteRefusedError(`${intent.nodeType}: an identical earlier write to ${host(intent.baseUrl)} (queued ${unresolved.queuedAt}) has an unknown outcome. Open BCF → Drafts & publication and check the server before running this node again.`);
      }
      if (!claimed?.entries.some(entry => entry.id === entryId)) {
        throw new BcfWriteRefusedError(`${intent.nodeType}: the write intent could not be recorded in browser storage, so nothing was sent.`);
      }
      inFlightEntries.add(entryId);
      try {
        const result = await send();
        if (!result || typeof result !== 'object') throw new Error('BCF server receipt has no valid identifier.');
        const representations = sensitive.flatMap(secret => [...new Set([secret, JSON.stringify(secret).slice(1, -1)])]);
        for (const field of ['guid', 'topic_guid', 'viewpoint_guid', 'reply_to_comment_guid']) {
          const value: unknown = Reflect.get(result, field);
          if (field !== 'guid' && (value === undefined || value === null)) continue;
          if (typeof value !== 'string' || value.length === 0) throw new Error('BCF server receipt has no valid identifier.');
          if (representations.some(secret => value.includes(secret))) throw new Error('BCF server receipt contains a credential.');
        }
        await settle(id, entryId, entry => markDone(entry, { remoteGuid: result.guid, at: now().toISOString(), evidence: 'response' }));
        return result;
      } catch (error) {
        const classified = classifyWriteError(error, now().toISOString());
        for (const secret of sensitive) {
          for (const representation of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
            classified.failure.message = classified.failure.message.split(representation).join('[redacted]');
          }
        }
        await settle(id, entryId, entry => classified.state === 'failed' ? markFailed(entry, classified.failure) : markUncertain(entry, classified.failure));
        if (classified.state === 'failed') {
          if (sensitive.length === 0) throw error;
          // Remote detail and causes can echo literal/Player tokens unknown to
          // the host's secret map. Return only the already redacted diagnostic.
          throw error instanceof BcfApiError
            ? new BcfApiError(classified.failure.message, { status: error.status, url: target.serverUrl })
            : new Error(classified.failure.message);
        }
        throw new Error(`${intent.nodeType}: outcome unknown — the server may have applied this ${intent.operation} (${classified.failure.message}). It is recorded in BCF → Drafts & publication; check the server there before running this node again.`);
      } finally {
        inFlightEntries.delete(entryId);
      }
    },
  };
}

/** Record the attempt's own answer; if storage refuses, the entry stays `sending` and becomes `uncertain` on reload. */
async function settle(id: string, entryId: string, apply: (entry: OutboxEntry) => OutboxEntry): Promise<void> {
  const saved = await mutatePublication(id, current => {
    const entry = current?.entries.find(item => item.id === entryId);
    return current && entry?.state === 'sending' ? replaceEntry(current, apply(entry), new Date().toISOString()) : null;
  });
  if (!saved) console.warn('[BCF outbox] Flow write receipt could not be saved; the entry will be treated as uncertain');
}
