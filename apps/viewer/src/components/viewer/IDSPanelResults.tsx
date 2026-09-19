/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Boxes, Eye, EyeOff, Filter, Focus, Layers, RefreshCw } from 'lucide-react';
import type { UseIDSResult } from '@/hooks/useIDS';
import type { IDSFocusMode } from '@/store/slices/idsSlice';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { IDSAuditSummary } from './IDSAuditSummary';
import { ReportExportButton } from './IDSReportExportButton';
import { SpecificationCard } from './IDSSpecificationCard';
import { PassRateBar, StatusIcon } from './IDSPanelStatus';
import { cn } from '@/lib/utils';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

interface IDSPanelResultsProps {
  ids: UseIDSResult;
  multiModel: boolean;
  models: readonly { id: string; name: string }[];
  pendingModelId: string | null;
  setPendingModelId: (modelId: string | null) => void;
  onEntityClick: (modelId: string, expressId: number) => void;
  onCorrect: (specificationId: string) => void;
}

export function IDSPanelResults({
  ids,
  multiModel: idsMultiModel,
  models: idsModelList,
  pendingModelId,
  setPendingModelId,
  onEntityClick: handleEntityClick,
  onCorrect,
}: IDSPanelResultsProps) {
  const { t, locale } = useTranslation();
  const {
    auditReport, report, loading, activeSpecificationId, filterMode,
    isolationScope, isolateMode, isolationActive, visibilityFilterActive, focusMode,
    runValidation, clearIsolation, setFilterMode, setIsolationScope, setFocusMode,
    applyColors, isolateFailed, isolatePassed, isolateInvolved,
    exportReportJSON, exportReportHTML, exportReportBCF, bcfExportProgress,
    setActiveSpecification,
  } = ids;
  const failedActive = isolationActive && isolateMode === 'failed';
  const passedActive = isolationActive && isolateMode === 'passed';
  const involvedActive = isolationActive && isolateMode === 'involved';
  const handleIsolateFailed = () => { if (failedActive) clearIsolation(); else isolateFailed(); };
  const handleIsolatePassed = () => { if (passedActive) clearIsolation(); else isolatePassed(); };
  const handleIsolateInvolved = () => { if (involvedActive) clearIsolation(); else isolateInvolved(); };


  // Render validation results
  const renderResults = () => {
    if (!report) return null;

    // In 'spec' scope the isolate/color actions target the active
    // specification; disable them until one is selected.
    const specScope = isolationScope === 'spec';
    const noActiveSpec = specScope && !activeSpecificationId;
    const failedLabel = failedActive
      ? t('idsPanel.showAllFailed')
      : t(specScope ? 'idsPanel.isolateFailedSpec' : 'idsPanel.isolateFailedIds');
    const passedLabel = passedActive
      ? t('idsPanel.showAllPassed')
      : t(specScope ? 'idsPanel.isolatePassedSpec' : 'idsPanel.isolatePassedIds');
    const involvedLabel = involvedActive
      ? t('idsPanel.showAllInvolved')
      : t(specScope ? 'idsPanel.isolateInvolvedSpec' : 'idsPanel.isolateInvolvedIds');

    return (
      <>
        {/* Audit summary stays visible above the validation report so
            users can still see authoring issues alongside model results. */}
        {auditReport && auditReport.status !== 'valid' && (
          <div className="p-3 border-b">
            <IDSAuditSummary report={auditReport} auditing={false} />
          </div>
        )}

        {/* Summary Header */}
        <div className="p-3 border-b bg-muted/30" {...tourAnchor(TOUR_ANCHORS.idsSummary)}>
          {idsMultiModel && (
            <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground min-w-0">
              <span className="shrink-0">{t('idsPanel.validate')}</span>
              {/* Federation targets one model at a time. Surface it as a picker
                  (same plain-select pattern as Compare) so the user can both
                  see which model the results reflect and switch to another.
                  Changing it re-runs validation against the chosen model. */}
              <select
                value={pendingModelId ?? report.modelInfo.modelId}
                onChange={(e) => {
                  // An active isolation (failed/passed/involved) pins
                  // isolatedEntities to the OLD model's global ids. The new
                  // report replaces idsIsolateMode but leaves those ids in
                  // place, so the new target would look hidden. Clear the
                  // isolation before validating the newly picked model.
                  clearIsolation();
                  setPendingModelId(e.target.value);
                  void runValidation(e.target.value);
                }}
                disabled={loading}
                aria-label={t('idsPanel.modelToValidate')}
                className="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs text-foreground disabled:opacity-50"
              >
                {idsModelList.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-center gap-2 mb-2">
            <StatusIcon status={report.summary.failedSpecifications > 0 ? 'fail' : 'pass'} />
            <span className="font-medium text-sm">
              {t('idsPanel.specificationsPassed', {
                passed: formatLocaleNumber(locale, report.summary.passedSpecifications),
                total: formatLocaleNumber(locale, report.summary.totalSpecifications),
              })}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs text-center">
            <div className="bg-background rounded p-2">
              <div className="font-medium">{formatLocaleNumber(locale, report.summary.totalEntitiesChecked)}</div>
              <div className="text-muted-foreground">{t('idsPanel.checked')}</div>
            </div>
            <div className="bg-background rounded p-2">
              <div className="font-medium text-green-600">{formatLocaleNumber(locale, report.summary.totalEntitiesPassed)}</div>
              <div className="text-muted-foreground">{t('idsPanel.passed')}</div>
            </div>
            <div className="bg-background rounded p-2">
              <div className="font-medium text-red-600">{formatLocaleNumber(locale, report.summary.totalEntitiesFailed)}</div>
              <div className="text-muted-foreground">{t('idsPanel.failed')}</div>
            </div>
          </div>
          <div className="mt-2">
            <PassRateBar passRate={report.summary.overallPassRate} />
          </div>
          <p className="text-xs text-muted-foreground mt-2 text-center">
            {specScope
              ? t('idsPanel.specScopeHint')
              : t('idsPanel.idsScopeHint')}
          </p>
        </div>

        {/* Filter & Actions Bar */}
        <div className="p-2 border-b flex items-center gap-1 flex-wrap">
          <Select value={filterMode} onValueChange={(v) => setFilterMode(v as 'all' | 'failed' | 'passed')}>
            <SelectTrigger className="h-8 w-24">
              <Filter className="h-3 w-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('idsPanel.filter.all')}</SelectItem>
              <SelectItem value="failed">{t('idsPanel.filter.failed')}</SelectItem>
              <SelectItem value="passed">{t('idsPanel.filter.passed')}</SelectItem>
            </SelectContent>
          </Select>

          {/* Isolate scope: whole report vs. the active specification (#1236).
              'Per Spec' isolates the selected specification's elements
              (passed green, failed red). */}
          <Select value={isolationScope} onValueChange={(v) => setIsolationScope(v as 'ids' | 'spec')}>
            <SelectTrigger className="h-8 w-[112px]" aria-label={t('idsPanel.isolateScope')}>
              <Layers className="h-3 w-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ids">{t('idsPanel.scope.wholeIds')}</SelectItem>
              <SelectItem value="spec">{t('idsPanel.scope.perSpec')}</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex-1 min-w-2" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={failedActive ? 'secondary' : 'ghost'}
                size="sm"
                className={cn('h-8 w-8 p-0', failedActive && 'text-red-600')}
                aria-pressed={failedActive}
                aria-label={failedLabel}
                onClick={handleIsolateFailed}
                disabled={noActiveSpec}
                {...tourAnchor(TOUR_ANCHORS.idsIsolateFailed)}
              >
                <EyeOff className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {failedLabel}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={passedActive ? 'secondary' : 'ghost'}
                size="sm"
                className={cn('h-8 w-8 p-0', passedActive && 'text-green-600')}
                aria-pressed={passedActive}
                aria-label={passedLabel}
                onClick={handleIsolatePassed}
                disabled={noActiveSpec}
              >
                <Eye className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {passedLabel}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={involvedActive ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 w-8 p-0"
                aria-pressed={involvedActive}
                aria-label={involvedLabel}
                onClick={handleIsolateInvolved}
                disabled={noActiveSpec}
              >
                <Boxes className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {involvedLabel}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                aria-label={t('idsPanel.clearIsolation')}
                onClick={clearIsolation}
                disabled={!visibilityFilterActive}
              >
                <Focus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('idsPanel.clearIsolation')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={t('idsPanel.reapplyColors')} onClick={applyColors}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('idsPanel.reapplyColors')}</TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-4 mx-1" />

          <ReportExportButton
            onExportJSON={exportReportJSON}
            onExportHTML={exportReportHTML}
            onExportBCF={exportReportBCF}
            bcfExportProgress={bcfExportProgress}
            report={report}
          />
        </div>

        {/* On-select focus mode (#2867) — the same control, the same wording
            and the same three modes as the clash panel's, because it is the
            same action: how the rest of the model is shown when you activate
            one result row. */}
        <div className="flex items-center gap-1 px-2 py-1 border-b text-[11px] text-muted-foreground">
          <span>{t('idsPanel.onSelect')}</span>
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {([
              ['highlight', 'idsPanel.focus.highlight', 'idsPanel.focus.highlightTip'],
              ['isolate', 'idsPanel.focus.isolate', 'idsPanel.focus.isolateTip'],
              ['ghost', 'idsPanel.focus.ghost', 'idsPanel.focus.ghostTip'],
            ] as [IDSFocusMode, TranslationKey, TranslationKey][]).map(([m, labelKey, tipKey]) => (
              <button
                key={m}
                title={t(tipKey)}
                aria-pressed={focusMode === m}
                onClick={() => setFocusMode(m)}
                className={cn(
                  'px-1.5 py-0.5 transition-colors',
                  focusMode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                )}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Specifications List */}
        <ScrollArea className="flex-1" {...tourAnchor(TOUR_ANCHORS.idsResults)}>
          <div className="p-2 space-y-2">
            {report.specificationResults.map((specResult) => (
              <SpecificationCard
                key={specResult.specification.id}
                result={specResult}
                isActive={activeSpecificationId === specResult.specification.id}
                onSelect={() => setActiveSpecification(specResult.specification.id)}
                onEntityClick={handleEntityClick}
                onCorrect={() => onCorrect(specResult.specification.id)}
                filterMode={filterMode}
              />
            ))}
          </div>
        </ScrollArea>
      </>
    );
  };

  return renderResults();
}
