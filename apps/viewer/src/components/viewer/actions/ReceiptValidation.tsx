/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Validation verdicts linked to a reviewed-change receipt (P15): the counts
 * recorded at apply, "Re-run validation" while the batch is applied, and the
 * per-specification difference once re-run.
 */

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import type { ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import { verdictDelta, type VerdictCount } from '@/lib/actions/validation-verdicts';

const totals = (counts: readonly VerdictCount[]) => counts.reduce((sum, count) =>
  ({ failed: sum.failed + count.failed, passed: sum.passed + count.passed }), { failed: 0, passed: 0 });

export function ReceiptValidation({ receipt }: { receipt: ModelChangeReceipt }) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validation = receipt.validation;
  if (!validation) return null;
  const rerun = async () => {
    setRunning(true);
    setError(null);
    try {
      const { recordReceiptRerun, rerunReceiptValidation } = await import('@/lib/actions/validation-rerun');
      const outcome = await rerunReceiptValidation(useViewerStore, receipt);
      if (!outcome.ok) { setError(t(`receiptValidation.refused.${outcome.reason}`, { detail: outcome.detail ?? '' })); return; }
      if (outcome.receipt.validation) await recordReceiptRerun(receipt.id, outcome.receipt.validation);
    } catch (failure) {
      // A storage refusal keeps the report; the receipt just does not record the counts.
      console.error('[model-changes] recording the validation rerun failed', failure);
      setError(t('receiptValidation.refused.failed', { detail: failure instanceof Error ? failure.message : String(failure) }));
    } finally {
      setRunning(false);
    }
  };
  const delta = verdictDelta(validation);
  return <div className="space-y-1 border-t border-border/60 pt-1.5">
    <p>{t('receiptValidation.before', { title: validation.title, ...totals(validation.before) })}</p>
    {validation.beforeFreshness !== 'current' && <p className="text-muted-foreground">
      {t(validation.beforeFreshness === 'stale' ? 'receiptValidation.stale' : 'receiptValidation.unknown')}</p>}
    {validation.after && <>
      <p className="font-medium">{t('receiptValidation.after', totals(validation.after))}</p>
      {delta.length === 0 ? <p className="text-muted-foreground">{t('receiptValidation.noDelta')}</p>
        : <ul aria-label={t('receiptValidation.after', totals(validation.after))} className="space-y-0.5">{delta.map((row) =>
          <li key={row.id} className="break-words">{t('receiptValidation.delta', { name: row.name,
            beforeFailed: row.before?.failed ?? 0, afterFailed: row.after?.failed ?? 0,
            beforePassed: row.before?.passed ?? 0, afterPassed: row.after?.passed ?? 0 })}</li>)}</ul>}
    </>}
    {receipt.status === 'applied' && <Button size="sm" variant="outline" className="h-7" disabled={running} onClick={() => void rerun()}>
      {running ? <Spinner size="xs" className="mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
      {t(running ? 'receiptValidation.running' : 'receiptValidation.rerun')}
    </Button>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
