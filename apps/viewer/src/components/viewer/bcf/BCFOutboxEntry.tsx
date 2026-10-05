/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One outbox entry with its state, receipt and the only actions its state
 * allows (#6896): an unknown outcome can be checked against the server, a
 * checked candidate chosen, or — after a check found nothing — sent again.
 * There is no "retry" for an unknown outcome.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { checkEntry, requeueAfterCheck, resolveWithCandidate, settleRemoteConflict } from '@/lib/bcf-publication/outbox-check';
import type { PublicationConnection } from '@/lib/bcf-publication/outbox-dispatch';
import type { BcfPublication, OutboxEntry } from '@/lib/bcf-publication/outbox-types';

const STATE_KEYS = {
  queued: 'bcfDrafts.state.queued', sending: 'bcfDrafts.state.sending', done: 'bcfDrafts.state.done',
  failed: 'bcfDrafts.state.failed', uncertain: 'bcfDrafts.state.uncertain', blocked: 'bcfDrafts.state.blocked',
} as const satisfies Record<OutboxEntry['state'], TranslationKey>;
const OPERATION_KEYS = {
  createTopic: 'bcfDrafts.operation.createTopic', updateTopic: 'bcfDrafts.operation.updateTopic',
  createComment: 'bcfDrafts.operation.createComment', createViewpoint: 'bcfDrafts.operation.createViewpoint',
} as const satisfies Record<OutboxEntry['operation'], TranslationKey>;
const STATE_TONE: Record<OutboxEntry['state'], string> = {
  queued: 'text-muted-foreground', sending: 'text-muted-foreground', done: 'text-green-700 dark:text-green-400',
  failed: 'text-red-700 dark:text-red-400', uncertain: 'text-amber-700 dark:text-amber-400', blocked: 'text-amber-700 dark:text-amber-400',
};

export interface BCFOutboxEntryProps {
  record: BcfPublication;
  entry: OutboxEntry;
  label: string;
  /** Null when not connected to this record's server and account. */
  connection: PublicationConnection | null;
}

export function BCFOutboxEntry({ record, entry, label, connection }: BCFOutboxEntryProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); }
    catch (cause) {
      console.warn('[BCF outbox] Entry action failed', cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const checkable = entry.state === 'uncertain' || entry.state === 'blocked' && entry.blocked === 'imported';
  const check = entry.check;
  return (
    <li className="flex flex-col gap-0.5 border-b border-border/50 py-1 last:border-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate" title={label}>{t(OPERATION_KEYS[entry.operation])} · {label}</span>
        <span className={STATE_TONE[entry.state]}>{t(STATE_KEYS[entry.state])}</span>
      </div>
      {entry.receipt && <span className="text-2xs text-muted-foreground">{t(`bcfDrafts.receipt.${entry.receipt.evidence}`, { guid: entry.receipt.remoteGuid })}</span>}
      {entry.failure && entry.state !== 'done' && <span className="text-2xs text-muted-foreground">{entry.failure.message}</span>}
      {entry.blocked === 'imported' && <span className="text-2xs">{t('bcfDrafts.entry.imported')}</span>}
      {entry.blocked === 'remote-conflict' && (
        <div className="flex flex-wrap items-center gap-1 text-2xs">
          <span>{t('bcfDrafts.entry.remoteConflict')}</span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-2xs" disabled={busy}
            onClick={() => void run(() => settleRemoteConflict(record.id, entry.id, 'overwrite'))}>{t('bcfDrafts.entry.overwrite')}</Button>
          <Button size="sm" variant="outline" className="h-6 px-2 text-2xs" disabled={busy}
            onClick={() => void run(() => settleRemoteConflict(record.id, entry.id, 'discard'))}>{t('bcfDrafts.entry.discard')}</Button>
        </div>
      )}
      {checkable && (
        <div className="flex flex-wrap items-center gap-1 text-2xs">
          <Button size="sm" variant="outline" className="h-6 px-2 text-2xs" disabled={busy || !connection}
            title={connection ? undefined : t('bcfDrafts.entry.connectFirst', { server: record.target.serverUrl })}
            onClick={() => void run(async () => { if (connection) await checkEntry(record.id, entry.id, connection); })}>
            {t('bcfDrafts.entry.check')}
          </Button>
          {check?.result === 'absent' && connection && (
            <Button size="sm" variant="outline" className="h-6 px-2 text-2xs" disabled={busy}
              onClick={() => void run(() => requeueAfterCheck(record.id, entry.id, connection))}>
              {record.origin === 'flow' ? t('bcfDrafts.entry.releaseFlow') : t('bcfDrafts.entry.sendAgain')}
            </Button>
          )}
        </div>
      )}
      {check && entry.state !== 'done' && (
        <output className="block text-2xs">
          <span>{t(`bcfDrafts.check.${check.result}`, { count: check.candidates.length })}</span>
          {check.note && <span className="ml-1 text-muted-foreground">{check.note}</span>}
          {check.result === 'ambiguous' && (
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {check.candidates.map(candidate => (
                <li key={candidate.guid} className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate">{[candidate.title, candidate.author, candidate.date, candidate.guid].filter(Boolean).join(' · ')}</span>
                  <Button size="sm" variant="outline" className="h-6 px-2 text-2xs" disabled={busy}
                    onClick={() => void run(() => resolveWithCandidate(record.id, entry.id, candidate.guid))}>{t('bcfDrafts.entry.thisIsOurs')}</Button>
                </li>
              ))}
            </ul>
          )}
        </output>
      )}
      {error && <span role="alert" className="text-2xs text-red-700 dark:text-red-400">{error}</span>}
    </li>
  );
}
