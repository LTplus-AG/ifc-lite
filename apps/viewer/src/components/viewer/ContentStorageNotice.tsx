/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useDialogs } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import type { ContentStatus } from '@/lib/storage/content-library';

const messages = {
  quota: 'contentStorage.quota', unavailable: 'contentStorage.unavailable',
  conflict: 'contentStorage.conflict', invalid: 'contentStorage.invalid',
} as const satisfies Record<string, TranslationKey>;

/** Per-library acknowledgement follows transaction completion; refused drafts stay visible. */
export function ContentStorageNotice({ status, retry, restore }: {
  status: ContentStatus; retry: () => Promise<boolean>; restore: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { confirmDialog } = useDialogs();
  const [busy, setBusy] = useState(false);
  const states = Object.values(status.items);
  const problem = states.find(state => state in messages) as keyof typeof messages | undefined;
  const key = status.phase === 'loading' ? 'contentStorage.loading'
    : problem ? messages[problem] : status.phase === 'unavailable' ? 'contentStorage.unavailable'
      : states.includes('saving') ? 'contentStorage.saving' : states.length ? 'contentStorage.saved' : null;
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); }
    catch (error) { console.warn('[User content] Recovery action failed', error); }
    finally { setBusy(false); }
  };
  return <div className="shrink-0 px-2 py-1 text-xs" data-content-storage>
    {key && <p role={problem || status.phase === 'unavailable' ? 'alert' : 'status'}>{t(key)}</p>}
    {status.recovered && <p role="alert">{t('contentStorage.recovered')}</p>}
    {(problem || status.phase === 'unavailable') && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(retry)}>{t('validationPanel.history.retrySave')}</Button>}
    {problem && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
      if (await confirmDialog({ description: t('contentStorage.restoreConfirm'), destructive: true })) await restore();
    })}>{t('contentStorage.restore')}</Button>}
  </div>;
}
