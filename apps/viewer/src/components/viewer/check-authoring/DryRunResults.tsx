/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AlertTriangle, Crosshair } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { selectChangedEntity } from '@/lib/changes/select-changed-entity';
import type { DryRun, DryRunCheck } from '@/lib/check-authoring/dry-run';

function Check({ check, models }: { check: DryRunCheck; models: number }) {
  const { t } = useTranslation();
  const loaded = useViewerStore(s => s.models);
  const modelName = (id: string) => loaded.get(id)?.name ?? id;
  const cardinality = check.cardinality.filter(entry => !entry.passed);
  return <li className="border-b border-border/60 py-1.5 last:border-0 space-y-0.5">
    <p className="font-medium break-words">{check.name}{check.severity === 'warning' && <span className="ml-1 text-2xs text-muted-foreground">{t('checkAuthoring.warningSeverity')}</span>}</p>
    <p className="text-muted-foreground">{t('checkAuthoring.counts', { applicable: check.applicable, passed: check.passed, failed: check.failed })}
      {check.failedSets > 0 && ` · ${t('checkAuthoring.failedSets', { count: check.failedSets })}`}</p>
    {check.applicable === 0 && check.failedSets === 0 && <p className="flex items-start gap-1 text-amber-700 dark:text-amber-400">
      <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden="true" />{t('checkAuthoring.zeroPopulation', { count: models })}</p>}
    {cardinality.map(entry => <p key={entry.modelId} className="text-amber-700 dark:text-amber-400 break-words">{t('checkAuthoring.cardinalityModel', { model: modelName(entry.modelId), message: entry.message })}</p>)}
    {check.errors.map((error, index) => <p key={index} role="alert" className="text-destructive break-words">{t('checkAuthoring.unevaluable', { error })}</p>)}
    {check.failures.length > 0 && <ul aria-label={t('checkAuthoring.sampleFailures', { name: check.name })} className="pl-2 border-l border-border space-y-0.5">
      {check.failures.map(failure => <li key={`${failure.modelId}:${failure.expressId}`} className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <p className="truncate">{failure.name || failure.globalId || `#${failure.expressId}`} <span className="text-muted-foreground">{failure.entityType}</span></p>
          {failure.reason && <p className="text-muted-foreground break-words">{failure.reason}</p>}
        </div>
        <IconButton label={t('checkAuthoring.showInModel', { name: failure.name || failure.globalId || failure.entityType })} className="h-6 w-6 shrink-0"
          onClick={() => selectChangedEntity(failure.modelId, failure.expressId)}><Crosshair className="h-3.5 w-3.5" /></IconButton>
      </li>)}
      {check.failed > check.failures.length && <li className="text-muted-foreground">{t('checkAuthoring.moreFailures', { count: check.failed - check.failures.length })}</li>}
    </ul>}
  </li>;
}

/** Native dry-run counts per specification or rule, with sample failures that resolve in the live model. */
export function DryRunResults({ run, current }: { run: DryRun; current: boolean }) {
  const { t } = useTranslation();
  return <section aria-label={t('checkAuthoring.dryRunResults')} className="rounded border border-border p-2 space-y-1">
    <p className="font-medium">{t('checkAuthoring.dryRunOn', { count: run.checkedModels.length })}</p>
    {run.skippedModels.length > 0 && <p className="text-amber-700 dark:text-amber-400">{t('checkAuthoring.skippedModels', { count: run.skippedModels.length })}</p>}
    {!current && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-1.5">{t('checkAuthoring.dryRunStale')}</p>}
    <ul>{run.checks.map(check => <Check key={check.id + check.name} check={check} models={run.checkedModels.length} />)}</ul>
  </section>;
}
