/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publish a reviewed draft batch to the connected BCF server (#6896): pick a
 * project, preflight its permissions and vocabulary, publish through the
 * durable outbox, and review per-topic receipts. Unknown outcomes are
 * explained and resolved per entry; nothing is retried blindly. A draft topic
 * type the server's fixed list lacks is mapped to one of the server's own
 * types, preselected and shown before anything is sent.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import type { BcfProjectDto } from '@ifc-lite/bcf-api';
import { createConnectedClient, listBcfServerProjects, loadBcfServerConfig, subscribeBcfServer, type BcfServerConfig } from '@/services/bcf-server';
import type { DraftBatch } from '@/lib/bcf-drafts/draft-types';
import { sameTarget, type DispatchReport, type PublicationConnection } from '@/lib/bcf-publication/outbox-dispatch';
import { draftPublicationId, planDraftPublication } from '@/lib/bcf-publication/outbox-plan';
import { preflightPublication, type PreflightReport } from '@/lib/bcf-publication/outbox-preflight';
import { publishDraftBatch } from '@/lib/bcf-publication/outbox-publish';
import { preselectTopicTypes, publicationRules, unknownTopicTypes, type TopicTypeChoice } from '@/lib/bcf-publication/outbox-server-rules';
import { publicationCounts } from '@/lib/bcf-publication/outbox-state';
import { useBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import type { PublicationTarget } from '@/lib/bcf-publication/outbox-types';
import { BCFOutboxEntry } from './BCFOutboxEntry';

export function useBcfConnection(): { config: BcfServerConfig | null; connect: () => Promise<PublicationConnection | null> } {
  const [config, setConfig] = useState<BcfServerConfig | null>(() => loadBcfServerConfig());
  useEffect(() => subscribeBcfServer(() => setConfig(loadBcfServerConfig())), []);
  const connect = useCallback(async () => {
    const current = loadBcfServerConfig();
    return current ? { client: await createConnectedClient(), serverUrl: current.serverUrl, userId: current.userId } : null;
  }, []);
  return { config, connect };
}

export interface BCFPublicationPanelProps {
  batch: DraftBatch;
  /** Server users for assignee mapping, learned from the project's extensions at preflight. */
  onUsers: (users: string[]) => void;
  /** The outbox record of the selected project, so the dialog can show per-topic status. */
  onRecordId: (id: string | null) => void;
}

export function BCFPublicationPanel({ batch, onUsers, onRecordId }: BCFPublicationPanelProps) {
  const { t } = useTranslation();
  const { config, connect } = useBcfConnection();
  const [projects, setProjects] = useState<BcfProjectDto[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [report, setReport] = useState<DispatchReport | null>(null);
  const [connection, setConnection] = useState<PublicationConnection | null>(null);
  const [topicTypes, setTopicTypes] = useState<TopicTypeChoice>({});
  // A type choice and a preflight result belong to one server project.
  // Whatever moves the target (the project picker, or a reconnect to another
  // server) drops both, so neither is applied to or shown for a project the
  // user has not checked.
  const targetKey = `${config?.serverUrl ?? ''}\u0000${projectId}`;
  useEffect(() => { setTopicTypes({}); setPreflight(null); setReport(null); }, [targetKey]);

  useEffect(() => {
    setProjects(null); setConnection(null);
    if (!config) return;
    let live = true;
    void Promise.all([listBcfServerProjects(), connect()]).then(([list, connected]) => {
      if (!live) return;
      setProjects(list); setConnection(connected);
      setProjectId(current => current && list.some(item => item.project_id === current) ? current : config.projectId || list[0]?.project_id || '');
    }).catch(cause => {
      console.warn('[BCF publication] Projects could not be listed', cause);
      if (live) { setProjects([]); setError(cause instanceof Error ? cause.message : String(cause)); }
    });
    return () => { live = false; };
  }, [config, connect]);

  const target = useMemo<PublicationTarget | null>(() => config && projectId ? { serverUrl: config.serverUrl, projectId, userId: config.userId,
    projectName: projects?.find(item => item.project_id === projectId)?.name ?? undefined } : null, [config, projectId, projects]);
  const record = useBcfOutbox(state => target ? state.entries.find(entry => entry.id === draftPublicationId(batch.id, target)) : undefined);
  const recordId = target ? draftPublicationId(batch.id, target) : null;
  useEffect(() => onRecordId(recordId), [recordId, onRecordId]);
  const live = record && connection && sameTarget(record, connection) ? connection : null;
  const counts = record ? publicationCounts(record) : null;

  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); }
    catch (cause) {
      console.warn('[BCF publication] Action failed', cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const adopt = (result: PreflightReport) => {
    setPreflight(result);
    setTopicTypes(current => preselectTopicTypes(result, current));
  };
  const check = () => act(async () => {
    if (!target || !connection) return;
    const plan = await planDraftPublication(batch, record, target, undefined, { rules: publicationRules(connection), topicTypes });
    const result = await preflightPublication(connection.client, plan.record);
    adopt(result);
    onUsers(result.extensions.user_id_type ?? []);
  });
  const publish = () => act(async () => {
    if (!target || !connection) return;
    const published = await publishDraftBatch(batch, target, connection, { timeoutMs: 60_000, topicTypes });
    if (!published) { setError(t('bcfDrafts.publish.storageRefused')); return; }
    setReport(published.report);
    if (published.report.preflight) adopt(published.report.preflight);
  });
  const unknownTypes = unknownTopicTypes(preflight);

  if (!config) return <p className="text-xs text-muted-foreground">{t('bcfDrafts.publish.notConnected')}</p>;
  const titleOf = (guid: string) => batch.topics.find(topic => topic.guid === guid)?.title ?? t('bcfDrafts.publish.removedTopic');
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border p-2 text-xs" aria-label={t('bcfDrafts.publish.region')}>
      <label className="flex items-center gap-2">
        {t('bcfDrafts.publish.project')}
        <select className="h-7 min-w-0 flex-1 rounded border border-border bg-background" value={projectId}
          disabled={!projects?.length || busy} onChange={event => { setProjectId(event.target.value); setPreflight(null); setReport(null); }}>
          {(projects ?? []).map(project => <option key={project.project_id} value={project.project_id}>{project.name ?? project.project_id}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy || !target || !connection} onClick={() => void check()}>{t('bcfDrafts.publish.preflight')}</Button>
        <Button size="sm" className="h-7 px-2 text-xs" disabled={busy || !target || !connection || batch.topics.length === 0} onClick={() => void publish()}>
          {t('bcfDrafts.publish.publish', { count: batch.topics.length })}
        </Button>
      </div>
      {preflight && (
        <output className={`block ${preflight.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
          {preflight.ok ? t('bcfDrafts.preflight.ok', { warnings: preflight.warnings.filter(warning => warning.kind === 'unverified').length })
            : t('bcfDrafts.preflight.refused', { count: preflight.issues.length })}
          <ul className="list-disc pl-4">
            {[...preflight.issues.filter(issue => !(issue.field === 'topic_type' && unknownTypes.some(item => item.type === issue.value))),
              ...preflight.warnings.filter(warning => warning.kind === 'withheld')].map((issue, index) =>
              <li key={index}>{t(`bcfDrafts.preflight.${issue.kind}`, { field: issue.field ?? '', value: issue.value ?? '', type: issue.topicType ?? '',
                topic: issue.topicGuid ? titleOf(issue.topicGuid) : '', allowed: issue.allowed?.join(', ') || t('bcfDrafts.preflight.none') })}</li>)}
          </ul>
        </output>
      )}
      {unknownTypes.map(({ type, allowed }) => (
        <label key={type} className="flex flex-wrap items-center gap-2 rounded bg-amber-500/10 px-2 py-1">
          {t('bcfDrafts.publish.topicType', { type })}
          <select className="h-7 min-w-0 flex-1 rounded border border-border bg-background" value={topicTypes[type] ?? ''} disabled={busy}
            onChange={event => setTopicTypes(current => ({ ...current, [type]: event.target.value }))}>
            {allowed.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
      ))}
      {report && <output className="block">{t('bcfDrafts.publish.result', { sent: report.sent, done: report.receipts.length, failed: report.failed.length,
        uncertain: report.uncertain.length, waiting: report.waiting.length + report.blocked.length })}</output>}
      {counts && (counts.uncertain > 0 || counts.blocked > 0) && (
        <div role="alert" className="rounded bg-amber-500/10 px-2 py-1 text-amber-800 dark:text-amber-300">{t('bcfDrafts.publish.uncertainGuidance')}</div>
      )}
      {error && <p role="alert" className="text-red-700 dark:text-red-400">{error}</p>}
      {record && (
        <div>
          <p className="text-muted-foreground">{t('bcfDrafts.publish.queue', { done: counts?.done ?? 0, total: record.entries.length })}</p>
          {batch.topics.map(topic => {
            const entries = record.entries.filter(entry => entry.topicGuid === topic.guid);
            if (!entries.length) return null;
            return <div key={topic.guid} className="mt-1">
              <p className="font-medium">{topic.title}</p>
              <ul>{entries.map(entry => <BCFOutboxEntry key={entry.id} record={record} entry={entry} connection={live}
                label={entry.receipt?.remoteGuid ?? entry.subject ?? topic.title} />)}</ul>
            </div>;
          })}
        </div>
      )}
    </section>
  );
}
