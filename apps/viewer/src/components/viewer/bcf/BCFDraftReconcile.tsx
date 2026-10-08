/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compare a draft batch with the current clash run and apply each topic's
 * proposal explicitly (#6896). Nothing is re-assigned without a click; a
 * finding another topic holds is shown, never moved.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useClashGroupLibrary } from '@/lib/clash/group-workspace';
import { draftTopic } from '@/lib/bcf-drafts/draft-create';
import { applyTopicReconciliation, reconcileDraftBatch, reconciliationChanges, type BatchReconciliation } from '@/lib/bcf-drafts/draft-reconcile';
import type { DraftBatch } from '@/lib/bcf-drafts/draft-types';
import { currentDraftRun } from './useBcfDraftActions';

export function BCFDraftReconcile({ batch, onChange }: { batch: DraftBatch; onChange: (batch: DraftBatch) => void }) {
  const { t } = useTranslation();
  const [proposal, setProposal] = useState<BatchReconciliation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const compare = () => {
    const run = currentDraftRun();
    if (!run) { setProposal(null); setMessage(t('bcfDrafts.reconcile.noRun')); return; }
    const groups = useClashGroupLibrary.getState().entries;
    setProposal(reconcileDraftBatch(batch, { ...run, groupsOf: id => groups.find(entry => entry.id === id)?.groups }));
    setMessage(null);
  };
  const title = (guid: string) => batch.topics.find(topic => topic.guid === guid)?.title ?? guid;
  const apply = async (guid: string) => {
    const topic = proposal?.topics.find(item => item.topicGuid === guid);
    const next = topic ? await applyTopicReconciliation(batch, topic) : null;
    if (!next) { setMessage(t('bcfDrafts.reconcile.stale')); return; }
    onChange(next);
    setProposal(current => current ? { ...current, topics: current.topics.filter(item => item.topicGuid !== guid) } : current);
  };
  const draftUnplaced = async () => {
    if (!proposal?.unplaced.length) return;
    const topic = await draftTopic(t('bcfDrafts.reconcile.unplacedTitle'), proposal.unplaced, { kind: 'selection' }, batch.source.worldOffset);
    onChange({ ...batch, modifiedAt: new Date().toISOString(), topics: [...batch.topics, topic] });
    setProposal(current => current ? { ...current, unplaced: [] } : current);
  };
  const pending = proposal?.topics.filter(topic => reconciliationChanges(topic) > 0 || topic.claimedElsewhere.length > 0) ?? [];
  return (
    <section className="rounded-md border border-border p-2 text-xs" aria-label={t('bcfDrafts.reconcile.region')}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">{t('bcfDrafts.reconcile.intro')}</span>
        <Button size="sm" variant="outline" className="h-6 px-2 text-2xs" onClick={compare}>{t('bcfDrafts.reconcile.compare')}</Button>
      </div>
      {message && <output className="mt-1 block">{message}</output>}
      {proposal && (
        <output className="mt-1 flex flex-col gap-1">
          <p>{proposal.sameRun ? t('bcfDrafts.reconcile.sameRun') : pending.length || proposal.unplaced.length
            ? t('bcfDrafts.reconcile.changes', { count: pending.length }) : t('bcfDrafts.reconcile.noChanges')}</p>
          {pending.map(topic => (
            <div key={topic.topicGuid} className="flex items-center gap-2 rounded bg-muted/40 px-2 py-1">
              <span className="min-w-0 flex-1">
                {t('bcfDrafts.reconcile.topicSummary', { title: title(topic.topicGuid), unchanged: topic.unchanged.length,
                  gone: topic.disappeared.length, added: topic.added.length, elsewhere: topic.claimedElsewhere.length })}
              </span>
              {reconciliationChanges(topic) > 0 && (
                <Button size="sm" variant="outline" className="h-6 px-2 text-2xs" onClick={() => void apply(topic.topicGuid)}
                  aria-label={t('bcfDrafts.reconcile.applyTo', { title: title(topic.topicGuid) })}>{t('bcfDrafts.reconcile.apply')}</Button>
              )}
            </div>
          ))}
          {proposal.unplaced.length > 0 && (
            <div className="flex items-center gap-2 rounded bg-amber-500/10 px-2 py-1">
              <span className="min-w-0 flex-1">{t('bcfDrafts.reconcile.unplaced', { count: proposal.unplaced.length })}</span>
              <Button size="sm" variant="outline" className="h-6 px-2 text-2xs" onClick={() => void draftUnplaced()}>{t('bcfDrafts.reconcile.draftUnplaced')}</Button>
            </div>
          )}
        </output>
      )}
    </section>
  );
}
