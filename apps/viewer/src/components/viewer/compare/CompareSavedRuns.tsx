/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved analysis runs for reconciliation (#7370): the runs a person saved,
 * each reopened into this session's captures only when its models bind to
 * the open ones. A refusal lists every reason; nothing is reopened partly.
 */

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleDate } from '@/i18n/intlFormat';
import { useViewerStore } from '@/store';
import { bindSavedAnalysisRun, type BindRefusal, type BindRefusalCode } from '@/lib/compare/saved-analysis-run-binding';
import { deleteSavedAnalysisRun, useSavedAnalysisRuns } from '@/lib/compare/saved-analysis-runs';
import type { SavedAnalysisRun } from '@/lib/compare/saved-analysis-run-schema';
import type { RunKind } from '@/lib/compare/run-reconcile-types';

const REFUSALS = {
  runEdited: 'compareAnalysis.bind.runEdited', modelEdited: 'compareAnalysis.bind.modelEdited',
  sourceUnknown: 'compareAnalysis.bind.sourceUnknown', modelMissing: 'compareAnalysis.bind.modelMissing',
  modelReplaced: 'compareAnalysis.bind.modelReplaced', modelAmbiguous: 'compareAnalysis.bind.modelAmbiguous',
  modelMoved: 'compareAnalysis.bind.modelMoved',
} as const satisfies Record<BindRefusalCode, TranslationKey>;

export function CompareSavedRuns({ kind, onReopen }: { kind: RunKind; onReopen: (id: string) => void }) {
  const { t, locale } = useTranslation();
  const entries = useSavedAnalysisRuns(s => s.entries);
  const items = useSavedAnalysisRuns(s => s.status.items);
  const [refused, setRefused] = useState<{ id: string; refusals: BindRefusal[] } | null>(null);
  const runs = entries.filter(run => run.kind === kind).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  if (runs.length === 0) return null;

  const describe = (run: SavedAnalysisRun) => t('compareAnalysis.reconcile.runLabel', {
    time: formatLocaleDate(locale, new Date(run.capturedAt), { dateStyle: 'short', timeStyle: 'medium' }),
    models: run.models.map(model => model.name).join(', '),
  });

  const reopen = (saved: SavedAnalysisRun) => {
    const state = useViewerStore.getState();
    const bound = bindSavedAnalysisRun(saved, state);
    if (!bound.ok) { setRefused({ id: saved.id, refusals: bound.refusals }); return; }
    setRefused(null);
    // A capture under the same id predates this binding (its model ids may be another session's): the bound run replaces it.
    if (state.compareRunCaptures.some(run => run.id === saved.id)) state.removeCompareRunCapture(saved.id);
    onReopen(state.addCompareRunCapture(bound.run));
  };

  return (
    <section className="space-y-1" aria-label={t('compareAnalysis.reconcile.savedTitle')}>
      <p className="font-medium text-foreground">{t('compareAnalysis.reconcile.savedTitle')}</p>
      <ul className="space-y-1">
        {runs.map(run => {
          const label = describe(run);
          const state = items[run.id];
          const unsaved = state !== undefined && state !== 'saved' && state !== 'saving';
          return (
            <li key={run.id} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
                <Button type="button" size="sm" variant="outline" aria-label={t('compareAnalysis.reconcile.reopenLabel', { run: label })}
                  onClick={() => reopen(run)}>{t('compareAnalysis.reconcile.reopen')}</Button>
                <IconButton size="icon-sm" label={t('compareAnalysis.reconcile.deleteSaved', { run: label })}
                  onClick={() => { void deleteSavedAnalysisRun(run.id); }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </div>
              {unsaved && <p className="text-amber-700 dark:text-amber-400">{t('compareAnalysis.reconcile.savedNotStored')}</p>}
              {refused?.id === run.id && (
                <div role="alert" className="text-amber-700 dark:text-amber-400">
                  <p>{t('compareAnalysis.reconcile.reopenRefused')}</p>
                  <ul className="list-disc pl-4">
                    {refused.refusals.map((refusal, index) => (
                      <li key={`${refusal.code}-${index}`}>{t(REFUSALS[refusal.code], { model: refusal.model ?? '' })}</li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
