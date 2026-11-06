/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { ListChecks } from 'lucide-react';
import type { PanelHeaderAction } from '@/components/ui/panel-header';
import { useTranslation } from '@/i18n';
import { useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { useBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import { BCFDraftsDialog } from './BCFDraftsDialog';

/** Header action for BCF drafts & publication; names how many outbox entries wait for a decision. */
export function useBcfDraftsAction(): { action: PanelHeaderAction; dialog: ReactNode } {
  const { t } = useTranslation();
  const open = useBcfDraftLibrary(state => state.dialogOpen);
  const attention = useBcfOutbox(state => state.entries.reduce((count, record) =>
    count + record.entries.filter(entry => entry.state === 'uncertain' || entry.state === 'blocked').length, 0));
  return {
    action: {
      id: 'bcf-drafts',
      label: attention ? t('bcfDrafts.control.attention', { count: attention }) : t('bcfDrafts.control.title'),
      icon: <ListChecks className="h-4 w-4" />,
      attention: attention > 0,
      onSelect: () => useBcfDraftLibrary.setState({ dialogOpen: true }),
    },
    dialog: <BCFDraftsDialog open={open} onOpenChange={value => useBcfDraftLibrary.setState({ dialogOpen: value })} />,
  };
}
