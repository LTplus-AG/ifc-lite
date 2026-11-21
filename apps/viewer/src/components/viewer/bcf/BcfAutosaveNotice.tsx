/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';

const messages = {
  pending: 'bcf.autosave.pending',
  saved: 'bcf.autosave.saved',
  'too-large': 'bcf.autosave.tooLarge',
  unreadable: 'bcf.autosave.unreadable',
  invalid: 'bcf.autosave.invalid',
  quota: 'bcf.autosave.quota',
  unavailable: 'bcf.autosave.unavailable',
  conflict: 'bcf.autosave.conflict',
} as const;

export function BcfAutosaveNotice() {
  const { t } = useTranslation();
  const status = useViewerStore(state => state.bcfAutosaveStatus);
  const retry = useViewerStore(state => state.flushBcfAutosave);
  if (status === 'idle') return null;
  const problem = status !== 'pending' && status !== 'saved';
  return <div className="shrink-0 border-b px-3 py-2 text-xs">
    <p role={problem ? 'alert' : 'status'}>{t(messages[status])}</p>
    {(status === 'quota' || status === 'unavailable') &&
      <Button size="sm" variant="outline" className="mt-1" onClick={() => void retry()}>
        {t('validationPanel.history.retrySave')}
      </Button>}
  </div>;
}
