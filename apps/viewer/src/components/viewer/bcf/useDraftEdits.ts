/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The drafts dialog's edit lane (C-2). An asynchronous edit (merge, split,
 * remove member) is computed from the batch as it was when pressed, so the
 * editor is held until it lands; a second edit pressed on the same batch while
 * it stays on screen is refused, because it would land over the first from the
 * same stale batch.
 *
 * The lane belongs to the batch on screen (`batchId`): ANY change of the
 * active batch releases it, whether a pick in the batch list, an archive
 * import or a deleted batch moving the selection, or another tab. The new
 * batch's editor is usable at once, and the switched-away edit still lands in
 * its own batch, which `save` addresses. The release is not remembered per
 * batch: switching A -> B -> A while A's edit is still computing frees A's
 * editor too, so a second A edit can start before the first one lands.
 */

import { useAsyncRun } from '@/hooks/useAsyncRun';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import type { DraftEditResult } from '@/lib/bcf-drafts/draft-edit';
import type { DraftBatch } from '@/lib/bcf-drafts/draft-types';

const REFUSALS = { 'unknown-topic': 'bcfDrafts.edit.unknownTopic', 'empty-split': 'bcfDrafts.edit.emptySplit',
  'merge-needs-two': 'bcfDrafts.edit.mergeNeedsTwo', invalid: 'bcfDrafts.edit.invalid' } as const;

export interface DraftEdits {
  /** Apply a synchronous edit now, or hold the editor while an asynchronous one lands. */
  onEdit: (result: DraftEditResult | Promise<DraftEditResult>) => void;
  /** An asynchronous edit is in flight for this batch. */
  busy: boolean;
}

export function useDraftEdits(batchId: string | null, save: (batch: DraftBatch) => void): DraftEdits {
  const { t } = useTranslation();
  const flight = useAsyncRun({ key: batchId, label: 'BCF draft edit' });
  const land = (outcome: DraftEditResult) => {
    if (outcome.ok) save(outcome.batch);
    else toast.error(t(REFUSALS[outcome.reason]));
  };
  const onEdit = (result: DraftEditResult | Promise<DraftEditResult>) => {
    if (!(result instanceof Promise)) { land(result); return; }
    void flight.start(async () => {
      try { land(await result); }
      catch (error) { console.error('[BCF drafts] Edit failed', error); toast.error(t('bcfDrafts.edit.invalid')); }
    }).then(outcome => {
      // A refused edit was already computed; it never lands, but a failure in it is still logged.
      if (outcome.kind === 'refused') void result.catch(error => console.warn('[BCF drafts] Refused edit failed', error));
    });
  };
  return { onEdit, busy: flight.busy };
}
