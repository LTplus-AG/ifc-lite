/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publication acceptance harness (#6896): the real loopback BCF peer, the
 * viewer's token sign-in and connected client, a fake-indexeddb content
 * store, and draft batches from real clash-engine runs over the committed
 * sample's identities. No fetch response is substituted.
 */

import './content-backup-fixture.js';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { resolveManualClashGroups } from '@/lib/clash/manual-groups';
import { draftBatchFromGroups } from '@/lib/bcf-drafts/draft-create';
import { addDraftComment, editDraftTopic } from '@/lib/bcf-drafts/draft-edit';
import type { DraftBatch } from '@/lib/bcf-drafts/draft-types';
import { publishDraftBatch } from '@/lib/bcf-publication/outbox-publish';
import { readPublication } from '@/lib/bcf-publication/outbox-store';
import type { PublicationConnection } from '@/lib/bcf-publication/outbox-dispatch';
import type { BcfPublication } from '@/lib/bcf-publication/outbox-types';
import { clearBcfServerConfig, createConnectedClient, signInWithToken } from '@/services/bcf-server';
import { startLocalBcfServer, LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN } from './bcf-http-server';
import { groupOf, proxyWallRun, sampleElements, PROXY_WALL_RULE } from './bcf-draft-fixture';

export async function connectPeer(t: TestContext) {
  clearBcfServerConfig();
  const server = await startLocalBcfServer();
  t.after(async () => { clearBcfServerConfig(); await server.close(); });
  const config = await signInWithToken(server.baseUrl, LOCAL_BCF_TOKEN);
  const connection: PublicationConnection = { client: await createConnectedClient(), serverUrl: config.serverUrl, userId: config.userId };
  return { ...server, connection, target: { serverUrl: config.serverUrl, projectId: LOCAL_BCF_PROJECT, projectName: 'Local coordination', userId: config.userId } };
}

/** Two reviewed group topics (one with a comment), in the peer's vocabulary. */
export async function reviewedBatch(): Promise<DraftBatch> {
  const { proxies } = await sampleElements();
  const clashes = await proxyWallRun([[0, 1], [1], [2]]);
  const groups = [groupOf('g1', 'Riser through core walls', clashes, [proxies[0].key, proxies[1].key]),
    groupOf('g2', 'East wall penetration', clashes, [proxies[2].key])];
  let batch = await draftBatchFromGroups('Round 1', 'ws', resolveManualClashGroups(groups, clashes), { clashes, rules: [PROXY_WALL_RULE.id] });
  for (const topic of batch.topics) {
    const edited = editDraftTopic(batch, topic.guid, { priority: 'High' });
    assert.ok(edited.ok);
    batch = edited.batch;
  }
  const commented = addDraftComment(batch, batch.topics[0].guid, 'Sleeve sizes need site check.');
  assert.ok(commented.ok);
  return commented.batch;
}

export async function publish(batch: DraftBatch, peer: Awaited<ReturnType<typeof connectPeer>>) {
  const published = await publishDraftBatch(batch, peer.target, peer.connection);
  assert.ok(published, 'the plan must be durable before dispatch');
  const stored = await readPublication(published.plan.record.id);
  assert.ok(stored);
  return { report: published.report, record: stored.record, added: published.plan.added };
}

export function entriesOf(record: BcfPublication, operation: BcfPublication['entries'][number]['operation']) {
  return record.entries.filter(entry => entry.operation === operation);
}
