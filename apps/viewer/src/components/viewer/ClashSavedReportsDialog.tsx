/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Clash panel header's entry to saved clash reports (#6947). Only this
 * button is part of the panel; the dialog loads on first open
 * (`ClashSavedReportsDialogContent`).
 */

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { Save } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { useLibraryFocus } from '@/lib/libraries/library-focus';

type DialogContent = ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void }>;

export function ClashSavedReportsDialog() {
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
  return (
    <>
      <IconButton label={t('clashTools.savedReports.triggerTooltip')} className="h-7 w-7" onClick={show}>
        <Save className="h-4 w-4" />
      </IconButton>
      {Content && <Content open={open} onOpenChange={setOpen} />}
    </>
  );
}
