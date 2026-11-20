/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button';
import { useDialogs } from '@/components/ui/confirm-dialog';
import { useTranslation, type TranslationKey } from '@/i18n';
import { IDS_DRAFT_MAX_MIB } from '@/lib/ids-studio/draft-codec';
import { useIdsStudioDraftLibrary } from '@/lib/ids-studio/draft-library';
import { discardClosedIdsDraft, switchIdsDraft, useIdsDraftFeedback } from '@/lib/ids-studio/draft-viewer';
import { useViewerStore } from '@/store';
import type { ContentStatus } from '@/lib/storage/content-library';

function draftMessage(
  feedback: ReturnType<typeof useIdsDraftFeedback.getState>[string],
  status: ContentStatus['items'][string] | undefined,
): TranslationKey | null {
  if (feedback === 'pending' || status === 'saving') return 'idsStudio.drafts.saving';
  if (feedback === 'tooLarge') return 'idsStudio.drafts.tooLarge';
  if (feedback === 'unreadable') return 'idsStudio.drafts.unreadable';
  if (feedback === 'conflict' || status === 'conflict') return 'idsStudio.drafts.conflict';
  if (feedback || status === 'quota' || status === 'invalid' || status === 'unavailable') return 'idsStudio.drafts.unsaved';
  return null;
}

export function StudioDrafts() {
  const { t } = useTranslation();
  const { confirmDialog } = useDialogs();
  const active = useViewerStore(state => state.idsStudioDraftId);
  const { entries, status } = useIdsStudioDraftLibrary();
  const feedback = useIdsDraftFeedback();
  const others = entries.filter(entry => entry.id !== active).sort((left, right) => right.savedAt - left.savedAt);
  const message = (active ? draftMessage(feedback[active], status.items[active]) : null)
    ?? (status.phase === 'unavailable' ? 'idsStudio.drafts.unavailable'
      : active && status.items[active] === 'saved' ? 'idsStudio.drafts.saved' : null);
  const notice = (key: TranslationKey | null, className = '') => {
    if (!key) return null;
    const informational = key === 'idsStudio.drafts.saving' || key === 'idsStudio.drafts.saved';
    return <p role={informational ? 'status' : 'alert'} className={`${className} ${informational ? 'text-muted-foreground' : 'text-destructive'}`}>
      {t(key, { max: IDS_DRAFT_MAX_MIB })}</p>;
  };
  if (!message && !others.length) return null;
  return <div className="border-b border-border px-2 py-1 text-2xs">
    {notice(message)}
    {others.length > 0 && <details>
      <summary className="cursor-pointer font-medium">{t('idsStudio.drafts.heading')}</summary>
      {active && <p className="text-muted-foreground">{t('idsStudio.drafts.switch')}</p>}
      <ul className="max-h-40 space-y-1 overflow-auto">
        {others.map(draft => <li key={draft.id} className="flex flex-wrap items-center gap-1">
          <span className="min-w-0 flex-1 truncate" title={draft.title}>{draft.title || t('idsStudio.outline.untitled')}</span>
          <Button type="button" size="sm" variant="outline" className="h-6" onClick={() => void switchIdsDraft(draft)}>{t('idsStudio.drafts.restore')}</Button>
          <Button type="button" size="sm" variant="outline" className="h-6" onClick={() => void (async () => {
            if (await confirmDialog({ description: t('idsStudio.drafts.discardConfirm'), destructive: true,
              confirmLabel: t('idsStudio.drafts.discard') })) await discardClosedIdsDraft(draft);
          })()}>{t('idsStudio.drafts.discard')}</Button>
          {notice(draftMessage(feedback[draft.id], status.items[draft.id]), 'basis-full')}
        </li>)}
      </ul>
    </details>}
  </div>;
}
