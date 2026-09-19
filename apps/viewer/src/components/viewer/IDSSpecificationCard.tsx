/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { Building2, ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type { IDSSpecificationResult } from '@ifc-lite/ids';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { groupRequirementResults, computeCheckStats } from '@/hooks/ids/idsRequirementGrouping';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { EntityResultRow, RequirementGroupRow } from './IDSResultRows';
import { PassRateBar, StatusIcon } from './IDSPanelStatus';
import { getCorrectableRequirements } from './IDSCorrectionDialog';

interface SpecificationCardProps {
  result: IDSSpecificationResult;
  isActive: boolean;
  onSelect: () => void;
  onEntityClick: (modelId: string, expressId: number) => void;
  filterMode: 'all' | 'failed' | 'passed';
  onCorrect: () => void;
}

export function SpecificationCard({
  result,
  isActive,
  onSelect,
  onEntityClick,
  filterMode,
  onCorrect,
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

  // Only a scalar property requirement with an exact pset/property name is
  // correctable (#3929) — computed lazily so a spec with no failures (or no
  // correctable shape) never renders the action.
  const hasCorrectable = useMemo(
    () => result.failedCount > 0 && getCorrectableRequirements(result).length > 0,
    [result]
  );

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
                      requirements: formatLocaleNumber(locale, requirementGroups.length),
                    })}
                  </div>
                )}
              </div>
            </button>
          </CollapsibleTrigger>
          {hasCorrectable && (
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

        {/* Entity Results */}
        <CollapsibleContent>
          <Separator />
          <div className="p-2 pt-1 text-xs font-medium text-muted-foreground">{t('idsPanel.byEntity')}</div>
          <div className="max-h-64 overflow-auto">
            {filteredEntities.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground text-center">
                {t(filterMode === 'failed' ? 'idsPanel.noFailedEntities' : filterMode === 'passed' ? 'idsPanel.noPassedEntities' : 'idsPanel.noEntities')}
              </div>
            ) : (
              <div className="divide-y">
                {filteredEntities.slice(0, 100).map((entity) => (
                  <EntityResultRow
                    key={`${entity.modelId}:${entity.expressId}`}
                    entity={entity}
                    onClick={() => onEntityClick(entity.modelId, entity.expressId)}
                  />
                ))}
                {filteredEntities.length > 100 && (
                  <div className="p-2 text-xs text-muted-foreground text-center">
                    {t('idsPanel.showingEntities', { shown: formatLocaleNumber(locale, 100), total: formatLocaleNumber(locale, filteredEntities.length) })}
                  </div>
                )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
