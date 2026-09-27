/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef, useState } from 'react';
import { Building2, ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { EntityResult, SpecificationResult, SetResult } from '@ifc-lite/ids';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { groupRequirementResults, computeCheckStats } from '@/hooks/ids/idsRequirementGrouping';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { EntityResultRow, RequirementGroupRow, SetResultRow } from './IDSResultRows';
import { PassRateBar, StatusIcon } from './IDSPanelStatus';

interface SpecificationCardProps {
  result: SpecificationResult;
  isActive: boolean;
  onSelect: () => void;
  onEntityClick: (modelId: string, expressId: number) => void;
  filterMode: 'all' | 'failed' | 'passed';
  onIsolateSet: (members: SetResult['members']) => void;
  /** IDS-only (#3929 auto-correct); absent/false hides the action entirely —
   *  a rule-set spec has no correctable IDS facet to write through. */
  onCorrect?: () => void;
  correctable?: boolean;
}

function entityKey(entity: EntityResult): string {
  return `${entity.modelId}:${entity.expressId}`;
}

function EntityResultsList({ entities, onEntityClick }: {
  entities: EntityResult[];
  onEntityClick: (modelId: string, expressId: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedEntities, setExpandedEntities] = useState<Set<string>>(() => new Set());
  const virtualizer = useVirtualizer({
    count: entities.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    getItemKey: (index) => entityKey(entities[index]),
    overscan: 5,
  });

  return (
    <div ref={scrollRef} data-ids-entity-results className="max-h-64 overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const entity = entities[row.index];
          const key = entityKey(entity);
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full border-b border-border/60"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <EntityResultRow
                entity={entity}
                onClick={() => onEntityClick(entity.modelId, entity.expressId)}
                detailsOpen={expandedEntities.has(key)}
                onToggleDetails={() => setExpandedEntities((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SpecificationCard({
  result,
  isActive,
  onSelect,
  onEntityClick,
  filterMode,
  onIsolateSet,
  onCorrect,
  correctable = false,
}: SpecificationCardProps) {
  const { t, locale } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  // Filter entity results based on mode
  const filteredEntities = useMemo(() => {
    if (filterMode === 'all') return result.entityResults;
    return result.entityResults.filter((e) =>
      filterMode === 'failed' ? !e.passed : e.passed
    );
  }, [result.entityResults, filterMode]);

  // Regroup this specification's entity results by requirement ("check")
  // rather than by entity. A specification can carry several requirements
  // (fire rating, certificate ref, width, ...) — grouping first (before any
  // status filtering) keeps the per-requirement counts aligned across
  // entities; see idsRequirementGrouping.ts for why that ordering matters.
  const requirementGroups = useMemo(
    () => groupRequirementResults(result.entityResults),
    [result.entityResults]
  );
  const checkStats = useMemo(
    () => computeCheckStats(result.entityResults),
    [result.entityResults]
  );
  const filteredRequirementGroups = useMemo(() => {
    if (filterMode === 'all') return requirementGroups;
    return requirementGroups.filter((g) =>
      filterMode === 'failed' ? g.failedCount > 0 : g.passedCount > 0
    );
  }, [requirementGroups, filterMode]);
  const applicableChecks = checkStats.passedChecks + checkStats.failedChecks;

  // #5138: set-level (uniqueness/aggregate) results — never populated by
  // IDS, so this section only ever renders for a rule-set report.
  const setResults = result.setResults ?? [];
  const duplicateGroupCount = setResults.filter((s) => s.kind === 'duplicate' && !s.passed).length;
  const failedAggregateCount = setResults.filter((s) => s.kind === 'aggregate' && !s.passed).length;
  // The toolbar's failed/passed filter applies to set rows exactly as it
  // does to entity rows (review PRRT_kwDOQ3UF-86kc6tJ /
  // PRRT_kwDOQ3UF-86kdJDs): unfiltered, a rules report with mixed set
  // outcomes showed every set row regardless of the active filter.
  const filteredSetResults = useMemo(() => {
    if (filterMode === 'all') return setResults;
    return setResults.filter((s) => (filterMode === 'failed' ? !s.passed : s.passed));
  }, [setResults, filterMode]);

  const hasCorrectable = correctable && result.failedCount > 0;

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <div
        className={cn(
          'rounded-lg border transition-colors',
          isActive ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
        )}
      >
        {/* Specification Header. The "Correct" action is a real interactive
            control, so it lives OUTSIDE the collapse-toggle <button> as a
            sibling rather than nested inside it (a <button> inside a
            <button> is invalid HTML and breaks click targeting). */}
        <div className="flex items-start gap-2 p-3">
          <CollapsibleTrigger asChild>
            <button className="flex-1 min-w-0 flex items-start gap-2 text-left" onClick={onSelect}>
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 mt-0.5 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 mt-0.5 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <StatusIcon status={result.status} />
                  <span className="font-medium text-sm truncate">
                    {result.specification.name}
                  </span>
                </div>
                {result.specification.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                    {result.specification.description}
                  </p>
                )}
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Building2 className="h-3 w-3" />
                    {t('idsPanel.entities', { count: result.applicableCount, countDisplay: formatLocaleNumber(locale, result.applicableCount) })}
                  </span>
                  <span className="text-green-600">{t('idsPanel.passedCount', {
                    count: result.passedCount,
                    countDisplay: formatLocaleNumber(locale, result.passedCount),
                  })}</span>
                  <span className="text-red-600">{t('idsPanel.failedCount', {
                    count: result.failedCount,
                    countDisplay: formatLocaleNumber(locale, result.failedCount),
                  })}</span>
                </div>
                <div className="mt-2">
                  <PassRateBar passRate={result.passRate} />
                </div>
                {/* Check-level rate: an entity is failed by its FIRST failing
                    requirement while its other requirements still count as
                    passes here, so this normally reads HIGHER than the
                    entity-level rate above — both matter and are shown
                    separately rather than picking one. See computeCheckStats
                    for the denominator caveat. */}
                {applicableChecks > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t(requirementGroups.length > 1 ? 'idsPanel.checksPassedAcross' : 'idsPanel.checksPassed', {
                      passed: formatLocaleNumber(locale, checkStats.passedChecks),
                      total: formatLocaleNumber(locale, applicableChecks),
                      rate: formatLocaleNumber(locale, checkStats.checkPassRate / 100, { style: 'percent', maximumFractionDigits: 2 }),
                      count: requirementGroups.length,
                      requirements: formatLocaleNumber(locale, requirementGroups.length),
                    })}
                  </div>
                )}
                {/* #5138: set-level (uniqueness/aggregate) failures — never
                    populated by IDS, so this line only appears for a
                    rule-set report that has one of these requirement kinds. */}
                {(duplicateGroupCount > 0 || failedAggregateCount > 0) && (
                  <div className="mt-1 text-xs text-red-600">
                    {duplicateGroupCount > 0 && t('validationPanel.setResult.duplicateGroupsSummary', {
                      count: duplicateGroupCount,
                      countDisplay: formatLocaleNumber(locale, duplicateGroupCount),
                    })}
                    {duplicateGroupCount > 0 && failedAggregateCount > 0 && ' · '}
                    {failedAggregateCount > 0 && t('validationPanel.setResult.aggregateFailuresSummary', {
                      count: failedAggregateCount,
                      countDisplay: formatLocaleNumber(locale, failedAggregateCount),
                    })}
                  </div>
                )}
              </div>
            </button>
          </CollapsibleTrigger>
          {hasCorrectable && onCorrect && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 shrink-0"
              onClick={onCorrect}
            >
              <Wrench className="h-3.5 w-3.5 mr-1" />
              {t('idsPanel.correct')}
            </Button>
          )}
        </div>

        {/* Requirement Breakdown */}
        <CollapsibleContent>
          <Separator />
          <div className="p-2 space-y-1">
            {filteredRequirementGroups.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground text-center">
                {t(filterMode === 'failed' ? 'idsPanel.noFailedRequirements' : filterMode === 'passed' ? 'idsPanel.noPassedRequirements' : 'idsPanel.noRequirements')}
              </div>
            ) : (
              filteredRequirementGroups.map((group) => (
                <RequirementGroupRow key={group.key} group={group} onEntityClick={onEntityClick} />
              ))
            )}
          </div>
        </CollapsibleContent>

        {/* Set Results (#5138: uniqueness/aggregate groups) — above the
            entity rows, since a SetResult describes a GROUP, not one entity. */}
        {filteredSetResults.length > 0 && (
          <CollapsibleContent>
            <Separator />
            <div className="p-2 pt-1 text-xs font-medium text-muted-foreground">{t('validationPanel.setResult.heading')}</div>
            <div className="p-2 pt-0 space-y-1">
              {filteredSetResults.map((set, idx) => (
                <SetResultRow key={`${set.kind}:${set.label}:${idx}`} result={set} onIsolate={onIsolateSet} />
              ))}
              {result.setResultsTruncated && (
                <div className="p-1 text-xs text-muted-foreground text-center">
                  {t('validationPanel.setResult.truncated')}
                </div>
              )}
            </div>
          </CollapsibleContent>
        )}

        {/* Entity Results */}
        <CollapsibleContent>
          <Separator />
          <div className="p-2 pt-1 text-xs font-medium text-muted-foreground">{t('idsPanel.byEntity')}</div>
          {filteredEntities.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground text-center">
              {t(filterMode === 'failed' ? 'idsPanel.noFailedEntities' : filterMode === 'passed' ? 'idsPanel.noPassedEntities' : 'idsPanel.noEntities')}
            </div>
          ) : (
            <EntityResultsList entities={filteredEntities} onEntityClick={onEntityClick} />
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
