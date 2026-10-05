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
import { digestStrings } from '../bcf-drafts/draft-footer.js';
import { classifyWriteError } from './outbox-dispatch.js';
import { entryDigest, normalizeServerUrl } from './outbox-plan.js';
import { markDone, markFailed, markUncertain, replaceEntry } from './outbox-state.js';
import { inFlightEntries, mutatePublication } from './outbox-store.js';
import type { BcfPublication, OutboxEntry, PublicationTarget } from './outbox-types.js';

const UNRESOLVED = new Set<OutboxEntry['state']>(['queued', 'sending', 'uncertain', 'blocked']);

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

export function createViewerBcfWriteGateway(now: () => Date = () => new Date()): BcfWriteGateway {
  return {
    async write<T extends { guid: string }>(intent: BcfWriteIntent, send: () => Promise<T>): Promise<T> {
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
        await settle(id, entryId, entry => markDone(entry, { remoteGuid: result.guid, at: now().toISOString(), evidence: 'response' }));
        return result;
      } catch (error) {
        const classified = classifyWriteError(error, now().toISOString());
        await settle(id, entryId, entry => classified.state === 'failed' ? markFailed(entry, classified.failure) : markUncertain(entry, classified.failure));
        if (classified.state === 'failed') throw error;
        throw new Error(`${intent.nodeType}: outcome unknown — the server may have applied this ${intent.operation} (${classified.failure.message}). It is recorded in BCF → Drafts & publication; check the server there before running this node again.`, { cause: error });
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
