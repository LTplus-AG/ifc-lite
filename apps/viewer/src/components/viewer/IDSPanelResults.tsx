/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Results view for a `ValidationReport`, generalised over its source
 * (#5138 plan §5/§6): the summary header, filter/isolate toolbar, on-select
 * focus mode, and the specification card list. Driven by
 * `UseValidationResults` (`hooks/validation/useValidationResults.ts`) so the
 * exact same component renders an IDS report and a rule-set report alike.
 *
 * The federation per-model switcher (`multiModel`/`models`/`pendingModelId`)
 * and auto-correct (`onCorrect`/`correctableSpecIds`) stay IDS-only —
 * validating one federated model at a time and writing a scalar property
 * correction both assume an `IDSDocument`, which a rule-set report has none
 * of. A rule-set report instead shows a read-only summary of every model it
 * targeted (it already ran across all of them in one pass).
 */

import { Boxes, Eye, EyeOff, Filter, Focus, Layers, RefreshCw } from 'lucide-react';
import type { ValidationReport, IDSAuditReport } from '@ifc-lite/ids';
import type { UseValidationResults } from '@/hooks/validation/useValidationResults';
import type { IDSFocusMode } from '@/store/slices/idsSlice';
import { useViewerStore } from '@/store';
import { IconButton } from '@/components/ui/icon-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { IDSAuditSummary } from './IDSAuditSummary';
import { ReportExportButton } from './IDSReportExportButton';
import { SpecificationCard } from './IDSSpecificationCard';
import { PassRateBar, StatusIcon } from './IDSPanelStatus';
import { cn } from '@/lib/utils';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

interface IDSPanelResultsProps {
  results: UseValidationResults;
  /** IDS-only: re-run against a different federated model. Unused (never
   *  called) for a rule-set report — its switcher does not render. */
  runValidation: (targetModelId?: string) => Promise<ValidationReport | null>;
  /** IDS-only authoring-issue banner. */
  auditReport?: IDSAuditReport | null;
  /** IDS-only federation model switcher. */
  multiModel?: boolean;
  models?: readonly { id: string; name: string }[];
  pendingModelId?: string | null;
  setPendingModelId?: (modelId: string | null) => void;
  /** IDS-only: disables the switcher while a re-run is in flight. */
  validating?: boolean;
  onEntityClick: (modelId: string, expressId: number) => void;
  /** IDS-only auto-correct (#3929); absent hides the action for every card. */
  onCorrect?: (specificationId: string) => void;
  correctableSpecIds?: ReadonlySet<string>;
}

export function IDSPanelResults({
  results,
  runValidation,
  auditReport = null,
  multiModel: idsMultiModel = false,
  models: idsModelList = [],
  pendingModelId = null,
  setPendingModelId,
  validating = false,
  onEntityClick: handleEntityClick,
  onCorrect,
  correctableSpecIds,
}: IDSPanelResultsProps) {
  const { t, locale } = useTranslation();
  const {
    report, activeSpecificationId, filterMode,
    isolationScope, isolateMode, isolationActive, visibilityFilterActive, focusMode,
    clearIsolation, setFilterMode, setIsolationScope, setFocusMode,
    applyColors, isolateFailed, isolatePassed, isolateInvolved, isolateSetMembers,
    exportReportJSON, exportReportHTML, exportReportBCF, bcfExportProgress,
    setActiveSpecification,
  } = results;
  const storeModels = useViewerStore((s) => s.models);
  const failedActive = isolationActive && isolateMode === 'failed';
  const passedActive = isolationActive && isolateMode === 'passed';
  const involvedActive = isolationActive && isolateMode === 'involved';
  const handleIsolateFailed = () => { if (failedActive) clearIsolation(); else isolateFailed(); };
  const handleIsolatePassed = () => { if (passedActive) clearIsolation(); else isolatePassed(); };
  const handleIsolateInvolved = () => { if (involvedActive) clearIsolation(); else isolateInvolved(); };

  if (!report) return null;
  const isRules = report.source.kind === 'rules';

  const specScope = isolationScope === 'spec';
  const noActiveSpec = specScope && !activeSpecificationId;
  const failedLabel = failedActive ? t('idsPanel.showAllFailed') : t(specScope ? 'idsPanel.isolateFailedSpec' : 'idsPanel.isolateFailedIds');
  const passedLabel = passedActive ? t('idsPanel.showAllPassed') : t(specScope ? 'idsPanel.isolatePassedSpec' : 'idsPanel.isolatePassedIds');
  const involvedLabel = involvedActive ? t('idsPanel.showAllInvolved') : t(specScope ? 'idsPanel.isolateInvolvedSpec' : 'idsPanel.isolateInvolvedIds');

  return (
    <>
      {auditReport && auditReport.status !== 'valid' && (
        <div className="p-3 border-b">
          <IDSAuditSummary report={auditReport} auditing={false} />
        </div>
      )}

      <div className="p-3 border-b bg-muted/30" {...tourAnchor(TOUR_ANCHORS.idsSummary)}>
        {idsMultiModel && !isRules && (
          <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground min-w-0">
            <span className="shrink-0">{t('idsPanel.validate')}</span>
            <select
              value={pendingModelId ?? report.modelInfo[0]?.modelId}
              onChange={(e) => {
                clearIsolation();
                setPendingModelId?.(e.target.value);
                void runValidation(e.target.value);
              }}
              disabled={validating}
              aria-label={t('idsPanel.modelToValidate')}
              className="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs text-foreground disabled:opacity-50"
            >
              {idsModelList.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}
        {isRules && report.modelInfo.length > 0 && (
          <div className="mb-2 text-xs text-muted-foreground truncate">
            {t('validationPanel.results.validatedAgainst', {
              models: report.modelInfo.map((m) => storeModels.get(m.modelId)?.name ?? m.modelId).join(', '),
            })}
          </div>
        )}
        <div className="flex items-center gap-2 mb-2">
          <StatusIcon status={report.summary.failedSpecifications > 0 ? 'fail' : 'pass'} />
          <span className="font-medium text-sm">
            {t('idsPanel.specificationsPassed', {
              count: report.summary.totalSpecifications,
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
        <div className="mt-2"><PassRateBar passRate={report.summary.overallPassRate} /></div>
        <p className="text-xs text-muted-foreground mt-2 text-center">
          {t(specScope ? 'idsPanel.specScopeHint' : 'idsPanel.idsScopeHint')}
        </p>
      </div>

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

        <IconButton
          label={failedLabel}
          variant={failedActive ? 'secondary' : 'ghost'}
          size="sm"
          className={cn('h-8 w-8 p-0', failedActive && 'text-red-600')}
          aria-pressed={failedActive}
          onClick={handleIsolateFailed}
          disabled={noActiveSpec}
          {...tourAnchor(TOUR_ANCHORS.idsIsolateFailed)}
        >
          <EyeOff className="h-4 w-4" />
        </IconButton>

        <IconButton
          label={passedLabel}
          variant={passedActive ? 'secondary' : 'ghost'}
          size="sm"
          className={cn('h-8 w-8 p-0', passedActive && 'text-green-600')}
          aria-pressed={passedActive}
          onClick={handleIsolatePassed}
          disabled={noActiveSpec}
        >
          <Eye className="h-4 w-4" />
        </IconButton>

        <IconButton
          label={involvedLabel}
          variant={involvedActive ? 'secondary' : 'ghost'}
          size="sm"
          className="h-8 w-8 p-0"
          aria-pressed={involvedActive}
          onClick={handleIsolateInvolved}
          disabled={noActiveSpec}
        >
          <Boxes className="h-4 w-4" />
        </IconButton>

        <IconButton
          label={t('idsPanel.clearIsolation')}
          size="sm"
          className="h-8 w-8 p-0"
          onClick={clearIsolation}
          disabled={!visibilityFilterActive}
        >
          <Focus className="h-4 w-4" />
        </IconButton>

        <IconButton
          label={t('idsPanel.reapplyColors')}
          size="sm"
          className="h-8 w-8 p-0"
          onClick={applyColors}
        >
          <RefreshCw className="h-4 w-4" />
        </IconButton>

        <Separator orientation="vertical" className="h-4 mx-1" />

        <ReportExportButton
          onExportJSON={exportReportJSON}
          onExportHTML={exportReportHTML}
          onExportBCF={exportReportBCF}
          bcfExportProgress={bcfExportProgress}
          report={report}
        />
      </div>

      <div className="flex items-center gap-1 px-2 py-1 border-b text-2xs text-muted-foreground">
        <span>{t('idsPanel.onSelect')}</span>
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          {([
            ['highlight', 'idsPanel.focus.highlight', 'idsPanel.focus.highlightTip'],
            ['isolate', 'idsPanel.focus.isolate', 'idsPanel.focus.isolateTip'],
            ['ghost', 'idsPanel.focus.ghost', 'idsPanel.focus.ghostTip'],
          ] as [IDSFocusMode, TranslationKey, TranslationKey][]).map(([m, labelKey, tipKey]) => (
            <button
              key={m} title={t(tipKey)} aria-pressed={focusMode === m}
              onClick={() => setFocusMode(m)}
              className={cn('px-1.5 py-0.5 transition-colors', focusMode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>

      <ScrollArea className="flex-1" {...tourAnchor(TOUR_ANCHORS.idsResults)}>
        <div className="p-2 space-y-2">
          {report.specificationResults.map((specResult) => (
            <SpecificationCard
              key={specResult.specification.id}
              result={specResult}
              isActive={activeSpecificationId === specResult.specification.id}
              onSelect={() => setActiveSpecification(specResult.specification.id)}
              onEntityClick={handleEntityClick}
              onIsolateSet={isolateSetMembers}
              onCorrect={onCorrect ? () => onCorrect(specResult.specification.id) : undefined}
              correctable={correctableSpecIds?.has(specResult.specification.id) ?? false}
              filterMode={filterMode}
            />
          ))}
        </div>
      </ScrollArea>
    </>
  );
}
