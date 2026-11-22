/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback } from 'react';
import { useDialogs } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { useIfc } from '@/hooks/useIfc';
import { useTranslation } from '@/i18n';
import { formatLocaleList, formatLocaleNumber } from '@/i18n/intlFormat';
import { collectChangedModels, totalChangeCount } from '@/lib/export/model-changes';
import { realignLoadedModels, MissingAlignmentSourceError } from '@/lib/geo/realign-loaded-models';
import { useViewerStore } from '@/store';

export function useReloadModelsForAlignment(setShowReloadPrompt: (visible: boolean) => void) {
  const { t, locale } = useTranslation();
  const { confirmDialog } = useDialogs();
  const { addModel } = useIfc();
  return useCallback(async () => {
    try {
      const state = useViewerStore.getState();
      if (totalChangeCount(collectChangedModels(state)) > 0) {
        const confirmed = await confirmDialog({
          description: t('properties.georef.reloadUnexportedChanges'),
          confirmLabel: t('properties.georef.reloadModels'),
          destructive: true,
        });
        if (!confirmed) return;
        const live = useViewerStore.getState();
        if (live.models !== state.models || live.mutationVersion !== state.mutationVersion
          || live.scheduleData !== state.scheduleData || live.scheduleIsEdited !== state.scheduleIsEdited) {
          toast.error(t('properties.georef.reloadFailed'));
          return;
        }
      }
      const result = await realignLoadedModels(addModel);
      setShowReloadPrompt(false);
      if (result.state === 'partial') toast.error(t('properties.georef.reloadPartial', {
        loaded: formatLocaleNumber(locale, result.loaded), total: formatLocaleNumber(locale, result.total), failed: formatLocaleList(locale, result.failed),
      }));
      else if (result.state === 'completed') toast.success(t('properties.georef.reloadSuccess'));
    } catch (error) {
      if (error instanceof MissingAlignmentSourceError) toast.error(t('properties.georef.reloadMissingSource', { name: error.modelName }));
      else toast.error(error instanceof Error ? t('properties.georef.reloadFailedWithMessage', { message: error.message }) : t('properties.georef.reloadFailed'));
    }
  }, [addModel, confirmDialog, locale, setShowReloadPrompt, t]);
}
