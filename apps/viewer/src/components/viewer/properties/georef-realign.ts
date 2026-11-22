/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { toast } from '@/components/ui/toast';
import type { UseTranslationResult } from '@/i18n';
import { formatLocaleList, formatLocaleNumber } from '@/i18n/intlFormat';
import { isNativeWorkflowBusy } from '@/lib/flow/run-session';
import { realignLoadedModels, MissingAlignmentSourceError, ModelLoadPendingError } from '@/lib/geo/realign-loaded-models';
import type { NativeModelAdder } from '@/services/coordination-loader';

/** The panel's Re-align with localized refusals and outcome. True once the rebuild ran, so its prompt can close. */
export async function reloadModelsForAlignment(addModel: NativeModelAdder, { t, locale }: Pick<UseTranslationResult, 't' | 'locale'>): Promise<boolean> {
  if (isNativeWorkflowBusy()) {
    toast.error(t('flowAssistant.preflightRunningWorkflow'));
    return false;
  }
  try {
    const result = await realignLoadedModels(addModel);
    if (result.state === 'partial') toast.error(t('properties.georef.reloadPartial', {
      loaded: formatLocaleNumber(locale, result.loaded), total: formatLocaleNumber(locale, result.total), failed: formatLocaleList(locale, result.failed),
    }));
    else if (result.state === 'completed') toast.success(t('properties.georef.reloadSuccess'));
    return true;
  } catch (error) {
    if (error instanceof MissingAlignmentSourceError) toast.error(t('properties.georef.reloadMissingSource', { name: error.modelName }));
    else if (error instanceof ModelLoadPendingError) toast.error(t('properties.georef.reloadLoadPending'));
    else toast.error(error instanceof Error ? t('properties.georef.reloadFailedWithMessage', { message: error.message }) : t('properties.georef.reloadFailed'));
    return false;
  }
}
