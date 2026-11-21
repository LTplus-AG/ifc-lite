/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { bcfProjectMetadata } from './coordination-bcf-metadata';
import { coordination, idSchema } from './coordination-common';
import { emptySchema } from './contract';
import { disabled, invalidInput, stale, unavailable } from './refusals';
/** The connection identity bcf.server reports; bcf.connect compares against the same shape. */
export function bcfConnectionIdentity(config: { serverUrl: string; userId: string; projectId?: string; projectName?: string } | null) {
  return config ? { server_url: config.serverUrl, user_id: config.userId, project_id: config.projectId, project_name: config.projectName } : null;
}
export const coordinationBcfServerOperations = [
  coordination('bcf.server', 'Read native BCF server connection identity and selected project without exposing access/refresh tokens or app credentials.', ['read'], emptySchema, async () => {
    const { loadBcfServerConfig } = await import('@/services/bcf-server-config'); const config = loadBcfServerConfig();
    return { connection: bcfConnectionIdentity(config) };
  }),
  coordination('bcf.serverProjects', 'List BCF projects using the existing native connected provider and token lifecycle.', ['network', 'read'], emptySchema, async (_, c) => {
    const { createConnectedClient } = await import('@/services/bcf-server'); const client = await createConnectedClient(c.signal); const projects = await client.getProjects(); c.checkpoint?.(); return { projects };
  }),
  coordination<{ project_id: string; project_name: string; replace_project_id: string }>('bcf.pullProject', 'Pull and hydrate one server project through native BCF synchronization. Replacing local topics requires the exact inspected current local project id.', ['network', 'configuration'], {
    type: 'object', properties: { project_id: { type: 'string', minLength: 1, maxLength: 200 }, project_name: { type: 'string', maxLength: 500 }, replace_project_id: { type: 'string', maxLength: 200 } }, required: ['project_id', 'project_name', 'replace_project_id'], additionalProperties: false,
  }, async (i, c) => {
    const [{ pullBcfServerProject }, { loadBcfServerConfig, isSameBcfAccount }] = await Promise.all([
      import('@/services/bcf-server'), import('@/services/bcf-server-config'),
    ]);
    const account = loadBcfServerConfig();
    if (!account) throw disabled('Sign in through the native BCF server control before pulling a project.');
    const before = useViewerStore.getState().bcfProject;
    if ((before?.projectId ?? '') !== i.replace_project_id) throw stale('Local BCF project changed; inspect before replacing.');
    const pulled = await pullBcfServerProject(i.project_id, i.project_name, undefined, c.signal); c.checkpoint?.();
    return c.commit(() => {
      const live = loadBcfServerConfig();
      if (!live || !isSameBcfAccount(live, account)) throw stale('The BCF account changed during synchronization. Pull again from the current account.');
      if (useViewerStore.getState().bcfProject !== before) throw stale('Local BCF project changed during synchronization.');
      useViewerStore.getState().setBcfProject(pulled.project);
      return { project: bcfProjectMetadata(pulled.project), warnings: pulled.warnings };
    });
  }),
  coordination('bcf.outbox', 'Read durable native BCF publication attempts, receipts, unknown outcomes and blocked entries.', ['read'], emptySchema, async () => {
    const { readPublications } = await import('@/lib/bcf-publication/outbox-store'); return { publications: await readPublications() };
  }),
  coordination<{ batch_id: string; project_id: string; topic_types: Array<{ from: string; to: string }> }>('bcf.preparePublication', 'Build the exact native draft publication plan and server preflight, then stage the real native Publish review. No remote writes are dispatched; returns waiting-for-approval with exact payloads and digest.', ['network', 'configuration'], {
    type: 'object', properties: { batch_id: { type: 'string', minLength: 1, maxLength: 200 }, project_id: { type: 'string', minLength: 1, maxLength: 200 }, topic_types: { type: 'array', maxItems: 100, items: { type: 'object', properties: { from: { type: 'string', minLength: 1, maxLength: 200 }, to: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['from', 'to'], additionalProperties: false } } }, required: ['batch_id', 'project_id', 'topic_types'], additionalProperties: false,
  }, async (i, c) => {
    const requestedAt = Date.now(); // a user choice made while this prepares wins over the candidate
    const [{ loadBcfServerConfig, isSameBcfAccount }, { createConnectedClient }, { useBcfDraftLibrary, bcfDraftLibrary }, { planDraftPublication, draftPublicationId }, { readPublication }, { publicationRules, preselectTopicTypes }, { preflightPublication }, { stageBcfPublicationReview, bcfPublicationCandidateCurrent }] = await Promise.all([
      import('@/services/bcf-server-config'), import('@/services/bcf-server'), import('@/lib/bcf-drafts/draft-library'), import('@/lib/bcf-publication/outbox-plan'), import('@/lib/bcf-publication/outbox-store'), import('@/lib/bcf-publication/outbox-server-rules'), import('@/lib/bcf-publication/outbox-preflight'), import('@/lib/bcf-publication/review-candidate'),
    ]);
    await bcfDraftLibrary.initialize(); const batch = useBcfDraftLibrary.getState().entries.find(batch => batch.id === i.batch_id), config = loadBcfServerConfig();
    if (!batch) throw invalidInput('unknown-target', 'Unknown draft batch.');
    if (!config) throw unavailable('Sign in through the native BCF server control.');
    if (new Set(i.topic_types.map(choice => choice.from)).size !== i.topic_types.length) throw invalidInput('invalid-value', 'Each native draft topic type needs one unambiguous mapping.');
    const client = await createConnectedClient(c.signal);
    const target = { serverUrl: config.serverUrl, projectId: i.project_id, userId: config.userId };
    const rules = publicationRules(config);
    const existing = (await readPublication(draftPublicationId(batch.id, target)))?.record;
    let topicTypes = Object.fromEntries(i.topic_types.map(choice => [choice.from, choice.to]));
    let plan = await planDraftPublication(batch, existing, target, undefined, { rules, topicTypes });
    let preflight = await preflightPublication(client, plan.record, { signal: c.signal });
    c.checkpoint?.();
    const defaults = preselectTopicTypes(preflight, {});
    const missingChoices = Object.entries(defaults).filter(([type]) => !Object.hasOwn(topicTypes, type)
      && plan.record.entries.some(entry => entry.payload.topic_type === type && !entry.topicTypeFrom));
    if (missingChoices.length) {
      topicTypes = { ...topicTypes, ...Object.fromEntries(missingChoices) };
      plan = await planDraftPublication(batch, existing, target, undefined, { rules, topicTypes });
      preflight = await preflightPublication(client, plan.record, { signal: c.signal });
      c.checkpoint?.();
    }
    return c.commit(() => {
      const live = loadBcfServerConfig();
      if (!live || !isSameBcfAccount(live, config) || useBcfDraftLibrary.getState().entries.find(item => item.id === batch.id) !== batch) throw stale('BCF account or draft batch changed during preflight.');
      // A user choice made while this prepared would make the panel discard it at once; say so instead.
      if (!bcfPublicationCandidateCurrent({ requestedAt })) throw stale('The publication controls changed while this was prepared; prepare and review again.');
      const candidate = stageBcfPublicationReview(batch, target, topicTypes, plan, preflight, requestedAt);
      useBcfDraftLibrary.setState({ activeId: batch.id, dialogOpen: true }); useViewerStore.getState().openWorkspacePanel('bcf');
      return { state: 'waiting-for-approval', candidate };
    });
  }),
  coordination('bcf.publish', 'Present an already prepared exact publication candidate for the native Publish click. The bridge command grant cannot approve external BCF writes.', ['configuration', 'view'], idSchema, async (i, c) => {
    const [{ useBcfPublicationReview }, { useBcfDraftLibrary }, { loadBcfServerConfig }] = await Promise.all([import('@/lib/bcf-publication/review-candidate'), import('@/lib/bcf-drafts/draft-library'), import('@/services/bcf-server-config')]);
    return c.commit(() => { const candidate = useBcfPublicationReview.getState().candidate; if (candidate?.id !== i.id) throw stale('Publication candidate changed; prepare and review again.');
      // An edited draft would be dropped by the panel's freshness check, leaving nothing to approve.
      // The panel drops a candidate for another account at once; refuse instead of reporting an approvable review.
      const account = loadBcfServerConfig(); if (account?.serverUrl !== candidate.target.serverUrl || account?.userId !== candidate.target.userId) { useBcfPublicationReview.setState({ candidate: null }); throw stale('The BCF account changed after preparation; prepare and review again.'); }
      if (useBcfDraftLibrary.getState().entries.find(entry => entry.id === candidate.batchId)?.modifiedAt !== candidate.modifiedAt) { useBcfPublicationReview.setState({ candidate: null }); throw stale('The draft changed after preparation; prepare and review again.'); }
      useBcfDraftLibrary.setState({ activeId: candidate.batchId, dialogOpen: true }); useViewerStore.getState().openWorkspacePanel('bcf'); return { state: 'waiting-for-approval', candidate_id: candidate.id, digest: candidate.digest }; });
  }),
];
