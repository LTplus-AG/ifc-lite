/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { EntityResult, RequirementResult, SetResult, FailureReasonCode } from '@ifc-lite/ids';
import type { RequirementGroup } from '@/hooks/ids/idsRequirementGrouping';
import { Badge } from '@/components/ui/badge';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { StatusIcon } from './IDSPanelStatus';

/** i18n labels for the closed `FailureReasonCode` set (#5138 plan §6). */
const FAILURE_REASON_KEYS: Record<FailureReasonCode, TranslationKey> = {
  absent: 'validationPanel.reason.absent',
  mismatch: 'validationPanel.reason.mismatch',
  notNumeric: 'validationPanel.reason.notNumeric',
  cardinality: 'validationPanel.reason.cardinality',
  duplicate: 'validationPanel.reason.duplicate',
  aggregate: 'validationPanel.reason.aggregate',
  notDate: 'validationPanel.reason.notDate',
};

function isFailureReasonCode(value: string): value is FailureReasonCode {
  return value in FAILURE_REASON_KEYS;
}

/** `failureReason` is either translated IDS text or one of the closed
 *  `FailureReasonCode`s (rule-set reports, #5138) — translate the latter,
 *  pass the former through verbatim. */
export function useFailureReasonLabel(): (reason: string | undefined) => string | undefined {
  const { t } = useTranslation();
  return (reason) => {
    if (reason === undefined) return undefined;
    return isFailureReasonCode(reason) ? t(FAILURE_REASON_KEYS[reason]) : reason;
  };
}

interface EntityResultRowProps {
  entity: EntityResult;
  onClick: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}

export function EntityResultRow({ entity, onClick, detailsOpen, onToggleDetails }: EntityResultRowProps) {
  const { t } = useTranslation();

  return (
    <div className="hover:bg-muted/50 focus-within:bg-muted/50 focus-within:ring-2 focus-within:ring-primary focus-within:ring-inset rounded-md">
      <div className="flex items-center">
        <button
          type="button"
          className="flex-1 min-w-0 p-2 text-left flex items-center gap-2 focus:outline-none"
          onClick={onClick}
          aria-label={t(entity.passed ? 'idsPanel.entityAriaLabelPassed' : 'idsPanel.entityAriaLabelFailed', {
            name: entity.entityName || '#' + entity.expressId,
            type: entity.entityType,
          })}
        >
          <StatusIcon status={entity.passed ? 'pass' : 'fail'} />
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate">
              {entity.entityName || `#${entity.expressId}`}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {entity.entityType}
              {entity.globalId && ` · ${entity.globalId}`}
            </div>
          </div>
        </button>
        <button
          type="button"
          className="shrink-0 p-3 rounded hover:bg-accent focus:outline-none"
          onClick={onToggleDetails}
          aria-expanded={detailsOpen}
          aria-label={t(detailsOpen ? 'idsPanel.hideDetails' : 'idsPanel.showDetails')}
        >
          {detailsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
      {detailsOpen && (
        <div className="pl-8 pr-2 pb-2 space-y-1">
          {entity.requirementResults.map((req, idx) => (
            <RequirementResultRow key={req.requirement.id || idx} result={req} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Requirement Result Row Component
// ============================================================================

interface RequirementResultRowProps {
  result: RequirementResult;
}

function RequirementResultRow({ result }: RequirementResultRowProps) {
  const reasonLabel = useFailureReasonLabel();
  return (
    <div className="text-xs flex items-start gap-2 py-1">
      <StatusIcon status={result.status} />
      <div className="flex-1 min-w-0">
        <div className="text-muted-foreground">{result.checkedDescription}</div>
        {result.failureReason && (
          <div className="text-red-600 mt-0.5">{reasonLabel(result.failureReason)}</div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Requirement Group Row Component
// ============================================================================

interface RequirementGroupRowProps {
  group: RequirementGroup;
  onEntityClick: (modelId: string, expressId: number) => void;
}

export function RequirementGroupRow({ group, onEntityClick }: RequirementGroupRowProps) {
  const { t, locale } = useTranslation();
  const reasonLabel = useFailureReasonLabel();
  const [showFailures, setShowFailures] = useState(false);
  const hasFailures = group.failingEntities.length > 0;
  const status: 'pass' | 'fail' | 'not_applicable' =
    group.failedCount > 0 ? 'fail' : group.passedCount > 0 ? 'pass' : 'not_applicable';

  return (
    <div className="rounded-md border border-border/60">
      <button
        type="button"
        className="w-full p-2 text-left flex items-start gap-2 hover:bg-muted/50 rounded-md disabled:hover:bg-transparent"
        onClick={() => hasFailures && setShowFailures((v) => !v)}
        disabled={!hasFailures}
        aria-expanded={hasFailures ? showFailures : undefined}
      >
        <StatusIcon status={status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-2xs uppercase">{group.facetType}</Badge>
            <span className="text-xs truncate">{group.checkedDescription}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            <span className="text-green-600">{t('idsPanel.passedCount', {
              count: group.passedCount,
              countDisplay: formatLocaleNumber(locale, group.passedCount),
            })}</span>
            {' · '}
            <span className="text-red-600">{t('idsPanel.failedCount', {
              count: group.failedCount,
              countDisplay: formatLocaleNumber(locale, group.failedCount),
            })}</span>
            {group.notApplicableCount > 0 && (
              <>
                {' · '}
                <span>{t('idsPanel.notApplicableCount', {
                  count: group.notApplicableCount,
                  countDisplay: formatLocaleNumber(locale, group.notApplicableCount),
                })}</span>
              </>
            )}
          </div>
        </div>
        {hasFailures && (
          showFailures ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />
        )}
      </button>
      {showFailures && hasFailures && (
        <div className="pl-6 pr-2 pb-2 space-y-1">
          {group.failingEntities.map((entity) => (
            <button
              key={`${entity.modelId}:${entity.expressId}`}
              type="button"
              className="w-full text-left text-xs p-1.5 rounded hover:bg-muted/50 flex flex-col gap-0.5"
              onClick={() => onEntityClick(entity.modelId, entity.expressId)}
            >
              <span className="truncate">
                {entity.entityType}
                {entity.entityName ? ` · ${entity.entityName}` : ''}
                {entity.globalId ? ` · ${entity.globalId}` : ''}
              </span>
              {entity.failureReason && (
                <span className="text-red-600">{reasonLabel(entity.failureReason)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Set Result Row Component (#5138 plan §6: uniqueness / aggregate checks)
// ============================================================================

interface SetResultRowProps {
  result: SetResult;
  onIsolate: (members: SetResult['members']) => void;
}

/** One `SetResult` (a duplicate group or an aggregate over a group) as a
 *  collapsible row above the entity rows — it describes a GROUP, not a
 *  single entity, so it renders above `EntityResultRow`s rather than among
 *  them. Clicking the row isolates every member through the same
 *  `{modelId, expressId}[]` isolate path entity rows use. */
export function SetResultRow({ result, onIsolate }: SetResultRowProps) {
  const { t, locale } = useTranslation();
  const reasonLabel = useFailureReasonLabel();
  const [showMembers, setShowMembers] = useState(false);

  return (
    <div className="rounded-md border border-border/60">
      <div className="flex items-start gap-2 p-2">
        <button
          type="button"
          className="flex-1 min-w-0 flex items-start gap-2 text-left hover:bg-muted/50 rounded-md -m-1 p-1"
          onClick={() => setShowMembers((v) => !v)}
          aria-expanded={showMembers}
        >
          <StatusIcon status={result.passed ? 'pass' : 'fail'} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-2xs uppercase">{result.kind}</Badge>
              <span className="text-xs truncate">{result.label}</span>
              {result.groupKey && (
                <span className="text-xs text-muted-foreground truncate">({result.groupKey})</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t('validationPanel.setResult.actualExpected', { actual: result.actual, expected: result.expected })}
              {' · '}
              {t('validationPanel.setResult.members', {
                count: result.members.length,
                countDisplay: formatLocaleNumber(locale, result.members.length),
              })}
              {result.failureReason && (
                <span className="text-red-600"> · {reasonLabel(result.failureReason)}</span>
              )}
            </div>
          </div>
          {showMembers ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        </button>
        {result.members.length > 0 && (
          <button
            type="button"
            className="shrink-0 text-xs text-primary hover:underline px-1 py-1"
            onClick={() => onIsolate(result.members)}
          >
            {t('validationPanel.setResult.isolate')}
          </button>
        )}
      </div>
      {showMembers && (
        <div className="pl-6 pr-2 pb-2 text-xs text-muted-foreground">
          {result.members.map((m) => (
            <div key={`${m.modelId}:${m.expressId}`} className="truncate">
              {m.modelId}:{m.expressId}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
