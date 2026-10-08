/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { BulkQueryResult } from '@ifc-lite/mutations';
import type { UseTranslationResult } from '@/i18n';
import { beginActivity, finishActivity, updateActivity } from '@/lib/activity/activity-journal';
import type { BulkRuntimeFailure } from './BulkExecutionResult';

/** Native batches commit before yielding; cancellation does not undo those edits. */
export function startBulkOperationActivity(controller: AbortController,
  active: { current: AbortController | null }, cancelled: { current: boolean }, t: UseTranslationResult['t']) {
  const job = beginActivity({ kind: 'check', title: 'activityTray.job.bulk', cancel: () => {
    if (active.current !== controller) return;
    cancelled.current = true;
    controller.abort();
  } });
  return {
    progress(done: number, total: number) { updateActivity(job, { progress: { done, total } }); },
    finish(result: BulkQueryResult, failures: readonly BulkRuntimeFailure[]) {
      const stopped = failures.some(failure => failure.kind === 'cancelled');
      const changed = result.affectedEntityCount;
      // Native #5958: Stop in the final yield stopped no work; keep Completed.
      if (result.success) { finishActivity(job, 'completed'); return; }
      if (changed > 0) {
        finishActivity(job, 'partial', { detail: t(stopped ? 'activityTray.bulk.cancelledWithChanges'
          : 'activityTray.bulk.failedWithChanges', { count: changed }) });
      } else {
        finishActivity(job, stopped ? 'cancelled' : 'failed', result.errors?.length ? { detail: result.errors.join('; ') } : {});
      }
    },
    fail(error: unknown) {
      finishActivity(job, controller.signal.aborted ? 'cancelled' : 'failed',
        controller.signal.aborted ? {} : { detail: error instanceof Error ? error.message : String(error) });
    },
  };
}
