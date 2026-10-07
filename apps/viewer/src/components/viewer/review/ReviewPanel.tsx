/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review workspace (P18, #6922): findings from every analysis (clash,
 * validation, comparison, BCF topics, linked records) joined into coordination
 * cards on validated elements. The panel only reads native results; each card
 * keeps the native status verbatim, labels historical evidence as such, never
 * treats a partial run as resolution, and opens the original evidence.
 */

import '@/i18n/catalogues/review-workspace.register';

import { useMemo, useState } from 'react';
import { ListChecks, RefreshCw } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { cardTitle } from '@/lib/review/bcf-draft';
import { facetOptions, filterCards, type ReviewFilter } from '@/lib/review/facets';
import { currentReviewWorkspace, decisionFor, useReviewWorkspaces } from '@/lib/review/workspace';
import { AnalysisPanel } from '../analysis/AnalysisPanel';
import { ResultCoverage, ResultSource, ResultView } from '../result/ResultView';
import { ResultState } from '../result/ResultState';
import { ReviewActions, useCardActions } from './ReviewActions';
import { ReviewCard } from './ReviewCard';
import { ReviewFilters } from './ReviewFilters';
import { gapText } from './review-labels';
import { useReviewSnapshot } from './useReviewSnapshot';

export function ReviewPanel({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const { snapshot, refresh } = useReviewSnapshot();
  const workspace = currentReviewWorkspace(useReviewWorkspaces(s => s.entries));
  const models = useViewerStore(s => s.models);
  const [filter, setFilter] = useState<ReviewFilter>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const actions = useCardActions();
  const shown = useMemo(() => filterCards(snapshot.cards, filter, workspace), [snapshot.cards, filter, workspace]);
  const options = useMemo(() => facetOptions(snapshot.cards, snapshot.runs, workspace), [snapshot.cards, snapshot.runs, workspace]);
  const titles = useMemo(() => new Map(snapshot.cards.map(card => [card.key, cardTitle(card)])), [snapshot.cards]);
  // A selection only ever names cards that still exist and are shown.
  const targets = useMemo(() => shown.filter(card => selected.has(card.key)), [shown, selected]);
  const actionCards = targets.length > 0 ? targets : shown;
  const { totals } = snapshot;
  const gaps = snapshot.runs.filter(run => run.incomplete.length > 0);
  const problems = [
    ...snapshot.failed.map(item => t('reviewWorkspace.sourceFailed', { source: item.source })),
    ...gaps.map(run => t('reviewWorkspace.runIncomplete', { run: run.label, reasons: gapText(t, run.incomplete) })),
    ...(totals.unverifiedElements > 0 ? [t('reviewWorkspace.unverified', { count: totals.unverifiedElements })] : []),
  ];
  const empty = snapshot.cards.length === 0;
  const modelList = [...models.values()].map(model => ({ id: model.id, name: model.name }));
  const toggle = (key: string, on: boolean) => setSelected(prev => { const next = new Set(prev); if (on) next.add(key); else next.delete(key); return next; });

  return (
    <AnalysisPanel icon={<ListChecks />} title={t('reviewWorkspace.title')} onClose={onClose}
      actions={<IconButton label={t('reviewWorkspace.refresh')} className="h-7 w-7" onClick={refresh}><RefreshCw className="h-4 w-4" /></IconButton>}>
      <div className="min-h-0 flex-1 overflow-y-auto" data-review-panel>
        <ResultView source={t('reviewWorkspace.title')}
          header={<ResultSource source={t('reviewWorkspace.source')} models={modelList}
            population={t('reviewWorkspace.population', { count: new Set(snapshot.runs.map(run => run.source)).size })} />}
          coverage={!empty || problems.length > 0 ? <ResultCoverage status={problems.length > 0 ? 'partial' : 'complete'}
            counts={t('reviewWorkspace.counts', { elements: totals.uniqueElements, current: totals.currentFindings, historical: totals.historicalFindings,
              cards: totals.cards, topics: totals.topics })} incomplete={problems} /> : undefined}
          summary={!empty ? <p className="text-2xs text-muted-foreground">{t('reviewWorkspace.totalsNote')}</p> : undefined}
          filters={!empty ? <ReviewFilters options={options} filter={filter} onChange={setFilter} /> : undefined}
          actions={!empty ? <ReviewActions cards={actionCards} selectedCount={targets.length} totals={totals} actions={actions}
            onSelectAll={() => setSelected(new Set(shown.map(card => card.key)))} onClearSelection={() => setSelected(new Set())} /> : undefined}
          rows={empty
            ? <ResultState kind="no-population" title={t('reviewWorkspace.empty.title')}
              details={[t(models.size === 0 ? 'reviewWorkspace.empty.noModels' : 'reviewWorkspace.empty.noResults')]} />
            : shown.length === 0
              ? <ResultState kind="filtered" details={[t('reviewWorkspace.filtered.detail')]} />
              : <section aria-label={t('reviewWorkspace.cards')}>
                <p aria-live="polite" className="px-3 py-1 text-2xs text-muted-foreground">{t('reviewWorkspace.showing', { count: shown.length })}</p>
                <ul>{shown.map(card => (
                  <ReviewCard key={card.key} card={card} titles={titles} decision={decisionFor(workspace, card.key)} expanded={open === card.key}
                    selected={selected.has(card.key)} onSelect={on => toggle(card.key, on)} onToggle={() => setOpen(open === card.key ? null : card.key)}
                    onOpenRelated={key => { setFilter({}); setOpen(key); }}
                    onDraft={() => void actions.draft([card])} />))}</ul>
              </section>} />
      </div>
    </AnalysisPanel>
  );
}
