/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reconcile two captured runs of one analysis across the current comparison
 * (#6921). The user captures completed native runs (a run over both
 * revisions can serve as base and head), picks a base and a head run, and
 * gets either new / resolved / persisting / changed / not-evaluated findings
 * or an explicit refusal listing every incompatibility. Nothing is re-run.
 */

import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useTranslation } from '@/i18n';
import { formatLocaleDate } from '@/i18n/intlFormat';
import { useViewerStore } from '@/store';
import type { CompareResult } from '@/store/slices/compareSlice';
import { captureClashRun, captureValidationRun, reconcileContextOf } from '@/lib/compare/compare-analysis-state';
import { reconcileRuns } from '@/lib/compare/run-reconcile';
import type { CapturedRun, RunKind } from '@/lib/compare/run-reconcile-types';
import { ReconcileOutcomeView } from './ReconcileOutcomeView';

function RunSelect({ label, runs, value, onChange, describe }: {
  label: string; runs: CapturedRun[]; value: string; onChange: (id: string) => void; describe: (run: CapturedRun) => string;
}) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <select aria-label={label} value={value} onChange={e => onChange(e.target.value)}
        className="w-full rounded border border-border bg-transparent px-2 py-1 text-foreground min-w-0">
        {runs.map(run => <option key={run.id} value={run.id}>{describe(run)}</option>)}
      </select>
    </>
  );
}

export function CompareReconcileSection({ result }: { result: CompareResult }) {
  const { t, locale } = useTranslation();
  const models = useViewerStore(s => s.models);
  const captures = useViewerStore(s => s.compareRunCaptures);
  const hasClash = useViewerStore(s => !!(s.clashRawResult ?? s.clashResult));
  const hasValidation = useViewerStore(s => !!s.idsValidationReport);
  const stored = useViewerStore(s => s.compareReconciliation);
  const [kind, setKind] = useState<RunKind>('clash');
  const [picked, setPicked] = useState<{ base?: string; head?: string }>({});

  const runs = useMemo(() => captures.filter(run => run.kind === kind), [captures, kind]);
  // Newest first: the head defaults to the latest capture, the base to the one before it (or the same run).
  const headId = runs.some(r => r.id === picked.head) ? picked.head! : runs[0]?.id ?? '';
  const baseId = runs.some(r => r.id === picked.base) ? picked.base! : runs[1]?.id ?? runs[0]?.id ?? '';
  const outcome = stored && stored.comparison === result && stored.outcome.kind === kind ? stored.outcome : null;
  const canCapture = kind === 'clash' ? hasClash : hasValidation;

  const describe = (run: CapturedRun) => t('compareAnalysis.reconcile.runLabel', {
    time: formatLocaleDate(locale, new Date(run.capturedAt), { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    models: run.modelIds ? run.modelIds.map(id => models.get(id)?.name ?? id).join(', ') : t('compareAnalysis.reconcile.modelsUnknown'),
  });

  const capture = () => {
    const state = useViewerStore.getState();
    const run = kind === 'clash' ? captureClashRun(state) : captureValidationRun(state);
    if (!run) return;
    const id = state.addCompareRunCapture(run);
    // The new run becomes the head; the base stays the run shown as base before it (or the new run when none was).
    setPicked(p => ({ base: p.base ?? (baseId || id), head: id }));
  };

  const reconcile = () => {
    const state = useViewerStore.getState();
    const base = runs.find(r => r.id === baseId), head = runs.find(r => r.id === headId);
    if (!base || !head) return;
    state.setCompareReconciliation({ outcome: reconcileRuns(base, head, reconcileContextOf(state)), comparison: result });
  };

  return (
    <div className="space-y-2 text-xs">
      <SegmentedControl size="sm" label={t('compareAnalysis.reconcile.kindLabel')} value={kind}
        onValueChange={value => { setKind(value); setPicked({}); }}
        options={[{ value: 'clash', label: t('compareAnalysis.reconcile.kind.clash') },
          { value: 'validation', label: t('compareAnalysis.reconcile.kind.validation') }]} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!canCapture} onClick={capture}>
          {t('compareAnalysis.reconcile.capture')}
        </Button>
        {!canCapture && (
          <span className="text-muted-foreground">
            {t(kind === 'clash' ? 'compareAnalysis.reconcile.captureNoClash' : 'compareAnalysis.reconcile.captureNoValidation')}
          </span>
        )}
      </div>
      {runs.length === 0 ? (
        <p className="text-muted-foreground">{t('compareAnalysis.reconcile.none')}</p>
      ) : (
        <>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
            <RunSelect label={t('compareAnalysis.reconcile.baseRun')} runs={runs} value={baseId}
              onChange={id => setPicked(p => ({ ...p, base: id }))} describe={describe} />
            <RunSelect label={t('compareAnalysis.reconcile.headRun')} runs={runs} value={headId}
              onChange={id => setPicked(p => ({ ...p, head: id }))} describe={describe} />
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={reconcile}>{t('compareAnalysis.reconcile.run')}</Button>
            <IconButton size="icon-sm" label={t('compareAnalysis.reconcile.remove')}
              onClick={() => useViewerStore.getState().removeCompareRunCapture(headId)}>
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </>
      )}
      {outcome && <ReconcileOutcomeView outcome={outcome} />}
    </div>
  );
}
