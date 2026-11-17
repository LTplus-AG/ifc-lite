/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { create } from 'zustand';
import type { DraftBatch } from '../bcf-drafts/draft-types';
import { digestStrings } from '../bcf-drafts/draft-footer';
import { publishDraftBatch } from './outbox-publish';
import { draftPublicationId, planDraftPublication, type PublicationPlan } from './outbox-plan';
import { readPublication } from './outbox-store';
import { publicationRules, type TopicTypeChoice } from './outbox-server-rules';
import type { PublicationConnection } from './outbox-dispatch';
import type { PublicationTarget } from './outbox-types';
import type { PreflightReport } from './outbox-preflight';
export interface BcfPublicationReview {
  id: string; batchId: string; modifiedAt: string; target: PublicationTarget; topicTypes: TopicTypeChoice;
  plan: PublicationPlan; preflight: PreflightReport; digest: string;
}
export const useBcfPublicationReview = create<{ candidate: BcfPublicationReview | null }>(() => ({ candidate: null }));
export function publicationReviewDigest(batch: DraftBatch, target: PublicationTarget, topicTypes: TopicTypeChoice, plan: PublicationPlan): string {
  return digestStrings([JSON.stringify(batch), JSON.stringify(target), JSON.stringify(topicTypes), ...plan.record.entries.map(entry => `${entry.id}:${entry.digest}:${entry.state}:${entry.receipt?.remoteGuid ?? ''}`).sort()]);
}
export function stageBcfPublicationReview(batch: DraftBatch, target: PublicationTarget, topicTypes: TopicTypeChoice, plan: PublicationPlan, preflight: PreflightReport): BcfPublicationReview {
  const candidate: BcfPublicationReview = { id: crypto.randomUUID(), batchId: batch.id, modifiedAt: batch.modifiedAt, target, topicTypes, plan, preflight, digest: publicationReviewDigest(batch, target, topicTypes, plan) };
  useBcfPublicationReview.setState({ candidate }); return candidate;
}
/** Only the existing native Publish click calls this: staging a candidate is never approval. */
export async function publishNativeBcfReview(batch: DraftBatch, target: PublicationTarget, connection: PublicationConnection, topicTypes: TopicTypeChoice) {
  const candidate = useBcfPublicationReview.getState().candidate;
  // A staged candidate is spent by the first publish attempt, whatever its outcome, so a stale
  // or failed one never blocks the native Publish button.
  const release = () => { if (candidate && useBcfPublicationReview.getState().candidate === candidate) useBcfPublicationReview.setState({ candidate: null }); };
  const stale = (message: string): never => { release(); throw new Error(message); };
  if (candidate?.batchId === batch.id) {
    if ((candidate.target.serverUrl !== target.serverUrl || candidate.target.projectId !== target.projectId || candidate.target.userId !== target.userId) || JSON.stringify(candidate.topicTypes) !== JSON.stringify(topicTypes) || candidate.modifiedAt !== batch.modifiedAt) stale('The staged BCF publication changed. Check the current candidate before publishing.');
    const existing = (await readPublication(draftPublicationId(batch.id, target)))?.record;
    const current = await planDraftPublication(batch, existing, target, undefined, { rules: publicationRules(connection), topicTypes });
    // Entry ids of a not-yet-persisted plan are random. Bind wire digests and source batch, not those fresh ids.
    const wire = (plan: PublicationPlan) => plan.record.entries.map(entry => `${entry.digest}:${entry.state}:${entry.receipt?.remoteGuid ?? ''}`).sort();
    if (JSON.stringify(wire(current)) !== JSON.stringify(wire(candidate.plan))) stale('The durable publication outbox changed. Prepare and review the candidate again.');
  }
  try { return await publishDraftBatch(batch, target, connection, { timeoutMs: 60_000, topicTypes }); }
  finally { if (candidate?.batchId === batch.id) release(); }
}
