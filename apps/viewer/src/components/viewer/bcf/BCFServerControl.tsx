/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactNode } from 'react';
import { Cloud } from 'lucide-react';
import type { PanelHeaderAction } from '@/components/ui/panel-header';
import { useTranslation } from '@/i18n';
import { BCFServerDialog } from './BCFServerDialog';
import { useBcfDraftsAction } from './BCFDraftsControl';

/**
 * Header actions for the BCF server dialog and BCF drafts & publication
 * (#6896), as shared panel header entries (#8802). The dialogs mount from
 * `dialogs`, outside the header, so they survive the overflow menu closing.
 */
export function useBcfServerActions(): { server: PanelHeaderAction; drafts: PanelHeaderAction; dialogs: ReactNode } {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const drafts = useBcfDraftsAction();
  return {
    server: { id: 'bcf-server', label: t('bcf.serverControl.title'), icon: <Cloud className="h-4 w-4" />, onSelect: () => setOpen(true) },
    drafts: drafts.action,
    dialogs: <><BCFServerDialog open={open} onOpenChange={setOpen} />{drafts.dialog}</>,
  };
}
