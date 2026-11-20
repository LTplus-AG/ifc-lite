/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button';
import { useDialogs } from '@/components/ui/confirm-dialog';
import { useTranslation } from '@/i18n';
import { IDS_DRAFT_MAX_MIB } from '@/lib/ids-studio/draft-codec';
import { useIdsStudioDraftLibrary } from '@/lib/ids-studio/draft-library';
import { discardClosedIdsDraft, switchIdsDraft, useIdsDraftErrors } from '@/lib/ids-studio/draft-viewer';
import { useViewerStore } from '@/store';

export function StudioDrafts() {
  const { t } = useTranslation();
  const { confirmDialog } = useDialogs();
  const active = useViewerStore(state => state.idsStudioDraftId);
  const { entries, status } = useIdsStudioDraftLibrary();
  const errors = useIdsDraftErrors();
  const others = entries.filter(entry => entry.id !== active).sort((left, right) => right.savedAt - left.savedAt);
  const activeError = active ? errors[active] : undefined;
  const activeStatus = active ? status.items[active] : undefined;
  const message = activeError === 'tooLarge' ? t('idsStudio.drafts.tooLarge', { max: IDS_DRAFT_MAX_MIB })
    : status.phase === 'unavailable' ? t('idsStudio.drafts.unavailable')
      : activeError === 'conflict' || activeStatus === 'conflict' ? t('idsStudio.drafts.conflict')
        : activeError || activeStatus === 'quota' || activeStatus === 'invalid' || activeStatus === 'unavailable'
          ? t('idsStudio.drafts.unsaved') : null;
  if (!message && !others.length && activeStatus !== 'saved') return null;
  return <div className="border-b border-border px-2 py-1 text-2xs">
    {message ? <p role="alert" className="text-destructive">{message}</p>
      : activeStatus === 'saved' ? <p className="text-muted-foreground">{t('idsStudio.drafts.saved')}</p> : null}
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
          {errors[draft.id] === 'unreadable' && <p role="alert" className="basis-full text-destructive">{t('idsStudio.drafts.unreadable')}</p>}
          {status.items[draft.id] === 'conflict' && <p role="alert" className="basis-full text-destructive">{t('idsStudio.drafts.conflict')}</p>}
        </li>)}
      </ul>
    </details>}
  </div>;
}
