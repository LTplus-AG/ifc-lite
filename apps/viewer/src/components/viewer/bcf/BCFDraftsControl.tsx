/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ListChecks } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { useBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import { BCFDraftsDialog } from './BCFDraftsDialog';

/** Header control for BCF drafts & publication; names how many outbox entries wait for a decision. */
export function BCFDraftsControl() {
  const { t } = useTranslation();
  const open = useBcfDraftLibrary(state => state.dialogOpen);
  const attention = useBcfOutbox(state => state.entries.reduce((count, record) =>
    count + record.entries.filter(entry => entry.state === 'uncertain' || entry.state === 'blocked').length, 0));
  return (
    <>
      <IconButton label={attention ? t('bcfDrafts.control.attention', { count: attention }) : t('bcfDrafts.control.title')}
        variant={attention ? 'secondary' : 'ghost'} className="h-7 w-7" onClick={() => useBcfDraftLibrary.setState({ dialogOpen: true })}>
        <ListChecks className="h-4 w-4" />
      </IconButton>
      <BCFDraftsDialog open={open} onOpenChange={value => useBcfDraftLibrary.setState({ dialogOpen: value })} />
    </>
  );
}
