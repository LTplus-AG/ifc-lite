/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { toast } from '@/components/ui/toast';
import type { UseTranslationResult } from '@/i18n';
import { isNativeWorkflowBusy } from './run-session';

/**
 * Refuse a user open path that would clear the scene while a workflow holds
 * the lease. Its own loads would be refused by `assertWorkflowOwner`, so
 * clearing first leaves an empty scene (and lets a Re-align report success
 * with models missing). True when the caller must stop.
 */
export function refuseSceneClearWhileWorkflowBusy(t: UseTranslationResult['t']): boolean {
  if (!isNativeWorkflowBusy()) return false;
  toast.error(t('flowAssistant.preflightRunningWorkflow'));
  return true;
}
