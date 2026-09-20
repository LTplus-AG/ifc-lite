/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils';
import type { ClashSeverity } from '@ifc-lite/clash';
import { useTranslation, type TranslationKey } from '@/i18n';

export type ClashResultView = 'pairs' | 'issues' | 'groups';

const ORDER: ClashSeverity[] = ['critical', 'major', 'minor', 'info'];
const SEVERITY: Record<ClashSeverity, { labelKey: TranslationKey; color: string }> = {
  critical: { labelKey: 'clashGroups.severity.critical', color: '#f7768e' },
  major: { labelKey: 'clashGroups.severity.major', color: '#ff9e64' },
  minor: { labelKey: 'clashGroups.severity.minor', color: '#e0af68' },
  info: { labelKey: 'clashGroups.severity.info', color: '#7aa2f7' },
};
const ZERO_BY_SEVERITY: Record<ClashSeverity, number> = { critical: 0, major: 0, minor: 0, info: 0 };

interface ClashResultSummaryProps {
  total: number;
  shown: number;
  issueCount: number;
  manualGroupCount: number;
  resultView: ClashResultView;
  effectiveView: ClashResultView;
  setResultView: (view: ClashResultView) => void;
  clusterEpsilon: number;
  groupsAvailable: boolean;
  duplicateSetView: boolean;
  bySeverity?: Record<ClashSeverity, number>;
}

export function ClashResultSummary({
  total,
  shown,
  issueCount,
  manualGroupCount,
  resultView,
  effectiveView,
  setResultView,
  clusterEpsilon,
  groupsAvailable,
  duplicateSetView,
  bySeverity = ZERO_BY_SEVERITY,
}: ClashResultSummaryProps) {
  const { t } = useTranslation();
  const count = effectiveView === 'issues' ? issueCount : effectiveView === 'groups' ? manualGroupCount : total;
  const issues = t('clashGroups.issueCount', { count: issueCount });
  const pairs = t('clashGroups.pairCount', { count: total });
  const clashes = t('clashGroups.clashCount', { count: total });
  const description = effectiveView === 'issues'
    ? t('clashGroups.issuePairs', { issues, pairs })
    : effectiveView === 'groups'
      ? t('clashGroups.groupPairs', { groups: t('clashGroups.groupCount', { count: manualGroupCount }), pairs })
      : t(shown < total
        ? (groupsAvailable && !duplicateSetView ? 'clashGroups.clashSummaryShownIssues' : 'clashGroups.clashSummaryShown')
        : (groupsAvailable && !duplicateSetView ? 'clashGroups.clashSummaryIssues' : 'clashGroups.clashSummary'),
      { clashes, shown, issues });
  return (
    <>
      {total > 0 && (
        <div className="mb-1.5 inline-flex overflow-hidden rounded-md border border-border text-[11px]" title={t('clashGroups.viewTitle', { distance: clusterEpsilon })}>
          {(['pairs', 'issues', 'groups'] as const).filter((view) => !duplicateSetView || view !== 'issues').map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => setResultView(view)}
              disabled={view === 'issues' && !groupsAvailable}
              className={cn('px-2 py-0.5', effectiveView === view ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
            >
              {t(`clashGroups.view.${view}`)}
            </button>
          ))}
        </div>
      )}
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-2xl font-semibold tabular-nums">{count}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      {total > 0 && (
        <>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
            {ORDER.map((severity) => bySeverity[severity] > 0 ? (
              <div key={severity} style={{ width: `${(bySeverity[severity] / total) * 100}%`, background: SEVERITY[severity].color }} />
            ) : null)}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
            {ORDER.filter((severity) => bySeverity[severity] > 0).map((severity) => (
              <span key={severity} className="inline-flex items-center gap-1 text-muted-foreground">
                <span className="h-2 w-2 rounded-full" style={{ background: SEVERITY[severity].color }} />
                {t(SEVERITY[severity].labelKey)} {bySeverity[severity]}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
}
