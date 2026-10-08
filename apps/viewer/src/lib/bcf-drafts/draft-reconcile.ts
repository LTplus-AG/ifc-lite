/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reconcile a draft batch against a newer clash run (#6896). Each member is
 * matched with the same occurrence-then-review-key resolution the manual
 * clash groups use. The result is a proposal only: findings that vanished,
 * new matches of a topic's source group, and matches already claimed by
 * another topic are listed, and nothing changes until the coordinator
 * applies a topic's proposal explicitly.
 */

import type { Clash } from '@ifc-lite/clash';
import { resolveManualClashGroups, type ManualClashGroup } from '../clash/manual-groups.js';
import { decodeDraftBatch } from './draft-codec.js';
import { findingFromClash, frameDraftMembers, runDigest } from './draft-create.js';
import { findingIdentity, type DraftBatch, type DraftFinding, type DraftTopic } from './draft-types.js';

export interface TopicReconciliation {
  topicGuid: string;
  /** Still present; snapshots refreshed from the newer run. */
  unchanged: DraftFinding[];
  /** Not found in the newer run (fixed, excluded, or the scope changed). */
  disappeared: DraftFinding[];
  /** New findings of this topic's source group, unclaimed elsewhere in the batch. */
  added: DraftFinding[];
  /** New findings of the source group that another topic already holds; never moved. */
  claimedElsewhere: Array<{ finding: DraftFinding; topicGuid: string }>;
}

export interface BatchReconciliation {
  runDigest: string;
  /** The batch was drafted from exactly this run. */
  sameRun: boolean;
  topics: TopicReconciliation[];
  /** New group matches whose source group backs several topics (after a split): placement is the coordinator's call. */
  unplaced: DraftFinding[];
}

export interface ReconcileRun {
  clashes: readonly Clash[];
  rules: readonly string[];
  /** Current group definitions of a workspace, when it is still available. */
  groupsOf: (workspaceId: string) => readonly ManualClashGroup[] | undefined;
}

export function reconcileDraftBatch(batch: DraftBatch, run: ReconcileRun): BatchReconciliation {
  const digest = runDigest(run.clashes, run.rules);
  const pseudoGroups: ManualClashGroup[] = batch.topics.map(topic => ({ id: topic.guid, name: topic.title,
    members: topic.members.map(member => ({ reviewKey: member.reviewKey, occurrenceKey: member.occurrenceKey })) }));
  const resolved = new Map(resolveManualClashGroups(pseudoGroups, run.clashes).map(group => [group.definition.id, group]));
  const holder = new Map<Clash, string>();
  for (const [guid, group] of resolved) for (const clash of group.members) holder.set(clash, guid);

  const originCount = new Map<string, number>();
  for (const topic of batch.topics) if (topic.origin.kind === 'group') {
    const key = JSON.stringify([topic.origin.workspaceId, topic.origin.groupId]);
    originCount.set(key, (originCount.get(key) ?? 0) + 1);
  }
  const unplaced: DraftFinding[] = [];
  const seenUnplaced = new Set<Clash>();
  const topics = batch.topics.map((topic): TopicReconciliation => {
    const group = resolved.get(topic.guid);
    const matchedIdentities = new Set(group?.memberDefinitions.map(member => findingIdentity(member)) ?? []);
    const unchanged = group?.members.map(findingFromClash) ?? [];
    const disappeared = topic.members.filter(member => !matchedIdentities.has(findingIdentity(member)));
    const added: DraftFinding[] = [];
    const claimedElsewhere: TopicReconciliation['claimedElsewhere'] = [];
    if (topic.origin.kind === 'group') {
      const origin = topic.origin;
      const definition = run.groupsOf(origin.workspaceId)?.find(item => item.id === origin.groupId);
      const current = definition ? resolveManualClashGroups([definition], run.clashes)[0]?.members ?? [] : [];
      const shared = (originCount.get(JSON.stringify([origin.workspaceId, origin.groupId])) ?? 0) > 1;
      for (const clash of current) {
        const owner = holder.get(clash);
        if (owner === topic.guid) continue;
        if (owner) claimedElsewhere.push({ finding: findingFromClash(clash), topicGuid: owner });
        else if (shared) { if (!seenUnplaced.has(clash)) { seenUnplaced.add(clash); unplaced.push(findingFromClash(clash)); } }
        else added.push(findingFromClash(clash));
      }
    }
    return { topicGuid: topic.guid, unchanged, disappeared, added, claimedElsewhere };
  });
  return { runDigest: digest, sameRun: digest === batch.source.runDigest, topics, unplaced };
}

export function reconciliationChanges(topic: TopicReconciliation): number {
  return topic.disappeared.length + topic.added.length;
}

/**
 * Apply one topic's proposal: drop vanished findings, add its unclaimed new
 * matches and refresh the snapshots of the rest. Refused (null) when the
 * batch changed so that the proposal would claim a finding twice.
 */
export async function applyTopicReconciliation(batch: DraftBatch, proposal: TopicReconciliation, now = new Date()): Promise<DraftBatch | null> {
  const topic = batch.topics.find(item => item.guid === proposal.topicGuid);
  if (!topic) return null;
  const members = [...proposal.unchanged, ...proposal.added];
  const viewpoint = await frameDraftMembers(members, batch.source.worldOffset);
  const { viewpoint: _previous, ...rest } = topic;
  const updated: DraftTopic = { ...rest, members, ...(viewpoint ? { viewpoint } : {}) };
  return decodeDraftBatch(JSON.parse(JSON.stringify({ ...batch, modifiedAt: now.toISOString(),
    topics: batch.topics.map(item => item.guid === topic.guid ? updated : item) })));
}
