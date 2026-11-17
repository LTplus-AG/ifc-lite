/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Clash panel header's entry to saved clash reports (#6947), as a shared
 * panel header action (#8802). Only the action is part of the panel; the
 * dialog loads on first open (`ClashSavedReportsDialogContent`).
 */

import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Save } from 'lucide-react';
import type { PanelHeaderAction } from '@/components/ui/panel-header';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { useLibraryFocus } from '@/lib/libraries/library-focus';

type DialogContent = ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void }>;

export function useClashSavedReportsAction(): { action: PanelHeaderAction; dialog: ReactNode } {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [Content, setContent] = useState<DialogContent | null>(null);
  const requested = useLibraryFocus(state => state.target);
  const consumed = useRef<typeof requested>(null);
  const show = useCallback((): void => {
    setOpen(true);
    if (Content) return;
    import('./ClashSavedReportsDialogContent')
      .then((module) => setContent(() => module.ClashSavedReportsDialogContent))
      .catch((error: unknown) => {
        console.warn('[Clash reports] The saved reports dialog could not be loaded', error);
        setOpen(false);
        toast.error(t('viewerShell.chunkError.loadFailed', { label: t('clashTools.savedReports.triggerTooltip') }));
      });
  }, [Content, t]);
  useEffect(() => {
    if (requested?.kind !== 'clash-report' || requested === consumed.current) return;
    consumed.current = requested;
    show();
  }, [requested, show]);
  return {
    action: { id: 'clash-saved-reports', label: t('clashTools.savedReports.triggerTooltip'), icon: <Save className="h-4 w-4" />, onSelect: show },
    dialog: Content ? <Content open={open} onOpenChange={setOpen} /> : null,
  };
}
