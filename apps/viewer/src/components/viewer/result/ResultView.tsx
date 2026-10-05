/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared result composition (U02, #6925; charter "Shared result and
 * review system"). Every analysis renders the same regions in the same order:
 *
 *   source     what produced this result: source, models, population
 *   coverage   completion status, the engine's own counts, incompleteness
 *   summary    the panel's native summary (severity bar, pass rate, A/B counts)
 *   filters    the panel's filter controls
 *   actions    scoped bulk actions and exports (a toolbar above the rows, where
 *              every adopted panel already had it)
 *   rows       typed rows/groups, or a `ResultState` when there are none
 *   evidence   underlying values for the focused row
 *
 * The regions are slots, not a generic table: each panel keeps its own row
 * renderers, so a clash list stays a clash list and a comparison stays a
 * comparison. This lives inside the existing `AnalysisPanel` scaffold (which
 * owns the header, run slot, error, progress and stale banner); it is not a
 * second panel shell.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { StatusChip, type ResultStatus } from './StatusChip';

export interface ResultModel {
  id: string;
  name: string;
}

interface ResultSourceProps {
  /** What ran: "Clash detection · Hard", an IDS title, "A → B". */
  source: string;
  models: readonly ResultModel[];
  /** The population the engine considered, as a complete message ("82 elements checked"). */
  population?: string;
}

/** The one source line: source, models (all of them, never a silent subset) and population. */
export function ResultSource({ source, models, population }: ResultSourceProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-2xs text-muted-foreground min-w-0">
      <span className="font-medium text-foreground truncate max-w-full">
        <span className="sr-only">{t('resultView.source')}: </span>{source}
      </span>
      {models.length > 0 && (
        <span className="min-w-0 truncate" title={models.map((m) => m.name).join(', ')}>
          {t('resultView.models', { count: models.length, names: models.map((m) => m.name).join(', ') })}
        </span>
      )}
      {population && (
        <span className="tabular-nums"><span className="sr-only">{t('resultView.population')}: </span>{population}</span>
      )}
    </div>
  );
}

interface ResultCoverageProps {
  status: ResultStatus;
  /** The engine's own counts as one complete message; never a derived score. */
  counts: string;
  /** Why the result is incomplete (failed rules, hidden rows, skipped models). */
  incomplete?: readonly string[];
}

/** Completion and coverage: a status chip, native counts and every known gap. */
export function ResultCoverage({ status, counts, incomplete = [] }: ResultCoverageProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-0.5 text-2xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="sr-only">{t('resultView.coverage')}</span>
        <StatusChip status={status} />
        <span className="text-muted-foreground tabular-nums">{counts}</span>
      </div>
      {incomplete.length > 0 && (
        <ul aria-label={t('resultView.incomplete')} className="list-disc pl-4 text-muted-foreground">
          {incomplete.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
    </div>
  );
}

interface ResultViewProps {
  /** Names the region for assistive technology ("Clash detection results"). */
  source: string;
  header?: ReactNode;
  coverage?: ReactNode;
  summary?: ReactNode;
  filters?: ReactNode;
  rows?: ReactNode;
  evidence?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Extra attributes for the summary block (tour anchors). */
  summaryProps?: Record<string, string>;
  summaryClassName?: string;
}

const SLOT = 'px-3 py-2 border-b border-border';

export function ResultView({
  source, header, coverage, summary, filters, rows, evidence, actions, className, summaryProps, summaryClassName,
}: ResultViewProps) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('resultView.region', { source })} className={cn('flex flex-col min-w-0', className)}>
      {(header || coverage) && (
        <div className={cn(SLOT, 'space-y-1')}>
          {header}
          {coverage}
        </div>
      )}
      {summary && <div className={cn(SLOT, 'py-2.5', summaryClassName)} {...summaryProps}>{summary}</div>}
      {filters}
      {actions && <div role="toolbar" aria-label={t('resultView.actions')}>{actions}</div>}
      {rows}
      {evidence && <section aria-label={t('resultView.evidence')}>{evidence}</section>}
    </section>
  );
}
